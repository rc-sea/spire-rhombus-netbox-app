/**
 * The collector: one NetBox stream, periodic reconciliation, a delivery loop,
 * a heartbeat with the probe result, and inventory on request.
 */

import { readFileSync } from 'node:fs';
import { type Heartbeat, type NetBoxStatus, SCHEMA_VERSION } from '@spire/shared';
import type { Logger } from 'pino';
import { Agent } from 'undici';
import { CloudClient, statusFromError } from './cloud.js';
import type { CollectorConfig } from './config.js';
import { Delivery } from './delivery.js';
import { takeInventory } from './inventory.js';
import { NbapiClient } from './nbapi/client.js';
import { DEFAULT_STREAM_TAGS, EventStream } from './nbapi/stream.js';
import { NbapiAuthError } from './nbapi/types.js';
import { fromStreamEvent, type NormalizeContext } from './normalize.js';
import { type ReconcileResult, reconcile } from './reconcile.js';
import { KV_LAST_RECONCILE_AT, Spool } from './spool.js';

export interface CollectorDeps {
  /** Override for tests. */
  netbox?: NbapiClient;
  cloud?: CloudClient;
  spool?: Spool;
  /** Shrinks timers in tests. */
  timeScale?: number;
}

export class Collector {
  readonly netbox: NbapiClient;
  readonly cloud: CloudClient;
  readonly spool: Spool;
  readonly delivery: Delivery;
  netboxStatus: NetBoxStatus = 'unreachable';
  lastEventAt: string | null = null;
  lastReconcile: ReconcileResult | null = null;
  apiVersionReported: string | null = null;
  eventsSeen = 0;
  private stream: EventStream | undefined;
  private timers: NodeJS.Timeout[] = [];
  private readonly stopController = new AbortController();
  private readonly startedAt = Date.now();
  private readonly ctx: NormalizeContext;
  private inventoryRequested = true; // publish once on start

  constructor(
    readonly config: CollectorConfig,
    readonly log: Logger,
    deps: CollectorDeps = {},
  ) {
    this.ctx = { collectorId: config.collectorId, siteTimezone: config.siteTimezone };
    this.netbox =
      deps.netbox ??
      new NbapiClient({
        baseUrl: config.netbox.baseUrl,
        username: config.netbox.username,
        password: config.netbox.password,
        version: config.netbox.version,
        pathFamily: config.netbox.pathFamily,
        bodyMode: config.netbox.bodyMode,
        sessionCookie: config.netbox.sessionCookie,
        paths: config.netbox.paths,
        dispatcher: new Agent({
          connections: 4,
          connect: {
            ...(config.netbox.tlsInsecure ? { rejectUnauthorized: false } : {}),
            ...(config.netbox.caFile ? { ca: readFileSync(config.netbox.caFile, 'utf8') } : {}),
          },
        }),
      });
    this.cloud =
      deps.cloud ?? new CloudClient({ baseUrl: config.cloud.baseUrl, secret: config.cloud.secret });
    this.spool =
      deps.spool ??
      new Spool({
        path: config.spool.path,
        maxEvents: config.spool.maxEvents,
        maxAgeDays: config.spool.maxAgeDays,
      });
    this.delivery = new Delivery(this.spool, this.cloud, log, {
      batchSize: config.deliveryBatchSize,
    });
  }

  /** Start everything. Resolves once the first probe attempt has completed (success or not). */
  async start(): Promise<void> {
    const scale = 1;
    void this.delivery.run();
    await this.probeNetBox();
    void this.runStream();
    this.timers.push(
      setInterval(() => void this.runReconcile(), this.config.intervals.reconcileMs * scale),
      setInterval(() => void this.sendHeartbeat(), this.config.intervals.heartbeatMs * scale),
      setInterval(() => {
        this.inventoryRequested = true;
      }, this.config.intervals.inventoryMs * scale),
    );
    void this.runReconcile();
    void this.sendHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    for (const t of this.timers) clearInterval(t);
    this.stream?.stop();
    this.delivery.stop();
    await this.netbox.logout().catch(() => undefined);
    this.spool.close();
  }

  /** Probe path family and API version; sets netboxStatus. */
  async probeNetBox(): Promise<void> {
    try {
      const r = await this.netbox.probe();
      this.apiVersionReported = r.apiVersion;
      this.netboxStatus = 'connected';
      const configured = this.config.netbox.version;
      const major = Number.parseInt(r.apiVersion, 10);
      if (configured !== 'auto' && Number.isFinite(major) && major !== configured) {
        // NBAPI version strings are not simply "1"/"2" (e.g. "4.7"); log for the human, do not block.
        this.log.warn(
          { configured, reported: r.apiVersion },
          'NBAPI version configured differs from reported',
        );
      }
      this.log.info(
        { pathFamily: r.pathFamily, apiVersion: r.apiVersion, tried: r.tried },
        'NetBox probe',
      );
    } catch (err) {
      this.netboxStatus = err instanceof NbapiAuthError ? 'auth-failed' : 'unreachable';
      this.log.error({ err: (err as Error).message }, 'NetBox probe failed');
    }
  }

  private async runStream(): Promise<void> {
    this.stream = new EventStream(this.netbox, {
      tags: DEFAULT_STREAM_TAGS,
      silenceTimeoutMs: this.config.intervals.streamSilenceMs,
      onStatus: (s, d) => {
        if (s === 'connected') {
          this.netboxStatus = 'connected';
          this.log.info('NetBox stream connected');
          void this.runReconcile(); // fill any gap from the outage
        } else if (s === 'stream-down') {
          if (/APIERROR 5/.test(d ?? '')) this.netboxStatus = 'auth-failed';
          else if (this.netboxStatus !== 'auth-failed') this.netboxStatus = 'stream-down';
          this.log.warn({ detail: d }, 'NetBox stream down');
        }
      },
    });
    for await (const ev of this.stream.events()) {
      if (this.stopController.signal.aborted) break;
      try {
        const e = fromStreamEvent(ev, this.ctx);
        this.spool.enqueue([e]);
        this.eventsSeen += 1;
        this.lastEventAt = e.receivedAt;
        this.delivery.poke();
      } catch (err) {
        this.log.warn(
          { err: (err as Error).message, tags: ev.tags },
          'could not normalize stream event',
        );
      }
    }
  }

  private reconciling = false;
  async runReconcile(): Promise<void> {
    if (this.reconciling || this.stopController.signal.aborted) return;
    this.reconciling = true;
    try {
      this.lastReconcile = await reconcile(this.netbox, this.spool, this.ctx, this.log);
      if (this.lastReconcile.newRecords > 0) this.delivery.poke();
      if (this.lastReconcile.error === null && this.netboxStatus === 'unreachable')
        this.netboxStatus = 'connected';
    } finally {
      this.reconciling = false;
    }
  }

  buildHeartbeat(): Heartbeat {
    return {
      schemaVersion: SCHEMA_VERSION,
      collectorId: this.config.collectorId,
      collectorVersion: this.config.collectorVersion,
      sentAt: new Date().toISOString(),
      netboxStatus: this.netboxStatus,
      nbapiVersionConfigured:
        this.config.netbox.version === 'auto' ? 2 : this.config.netbox.version,
      nbapiVersionReported: this.apiVersionReported
        ? `${this.apiVersionReported} (${this.netbox.pathFamily ?? 'unprobed'})`
        : null,
      lastEventAt: this.lastEventAt,
      lastReconcileAt: this.spool.get(KV_LAST_RECONCILE_AT) ?? null,
      lastReconcileResult: this.lastReconcile
        ? { newRecords: this.lastReconcile.newRecords, error: this.lastReconcile.error }
        : null,
      spoolSize: this.spool.size(),
      cloudStatus: this.delivery.status,
      hostUptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  async sendHeartbeat(): Promise<void> {
    if (this.stopController.signal.aborted) return;
    try {
      const res = await this.cloud.heartbeat(this.buildHeartbeat());
      if (res.actions.includes('refresh-inventory')) this.inventoryRequested = true;
      if (this.delivery.status === 'auth-failed') this.delivery.poke(); // secret works again
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, status: statusFromError(err) },
        'heartbeat failed',
      );
    }
    if (this.inventoryRequested) await this.publishInventory();
  }

  async publishInventory(): Promise<void> {
    if (this.netboxStatus === 'auth-failed') return;
    try {
      const snap = await takeInventory(this.netbox, this.config.collectorId, this.log);
      await this.cloud.inventory(snap);
      this.inventoryRequested = false;
      this.log.info({ items: snap.items.length }, 'inventory published');
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message },
        'inventory publish failed; will retry on next heartbeat',
      );
    }
  }
}
