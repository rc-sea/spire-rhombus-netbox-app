/**
 * Drain the spool to the cloud in batches, at least once, with backoff.
 * A 401/403 stops retries (status auth-failed) until `poke()` after the
 * secret is fixed; events stay in the spool.
 */
import { type CloudStatus, SCHEMA_VERSION } from '@spire/shared';
import type { Logger } from 'pino';
import { CloudAuthError, type CloudClient } from './cloud.js';
import type { Spool } from './spool.js';

export interface DeliveryOptions {
  batchSize?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Idle poll interval when the spool is empty. */
  idleMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class Delivery {
  status: CloudStatus = 'ok';
  lastError: string | undefined;
  delivered = 0;
  private readonly controller = new AbortController();
  private wake: (() => void) | undefined;
  private held = false;

  constructor(
    private readonly spool: Spool,
    private readonly cloud: CloudClient,
    private readonly log: Logger,
    private readonly opts: DeliveryOptions = {},
  ) {}

  /** Wake the loop (new events spooled, or secret fixed after auth failure). */
  poke(): void {
    this.held = false;
    this.wake?.();
  }

  stop(): void {
    this.controller.abort();
    this.wake?.();
  }

  /** Runs until stop(). */
  async run(): Promise<void> {
    const signal = this.controller.signal;
    const sleep = this.opts.sleep ?? defaultSleep;
    const minMs = this.opts.backoffMinMs ?? 1_000;
    const maxMs = this.opts.backoffMaxMs ?? 60_000;
    const idleMs = this.opts.idleMs ?? 2_000;
    const batchSize = this.opts.batchSize ?? 100;
    let backoff = minMs;
    while (!signal.aborted) {
      if (this.held) {
        await this.waitForPoke(signal, maxMs, sleep);
        continue;
      }
      const batch = this.spool.peek(batchSize);
      if (batch.length === 0) {
        this.status = 'ok';
        await this.waitForPoke(signal, idleMs, sleep);
        continue;
      }
      try {
        const res = await this.cloud.ingest({ schemaVersion: SCHEMA_VERSION, events: batch });
        const accepted = new Set(res.accepted);
        const rejectedIds = res.rejected.map((r: { id: string }) => r.id);
        if (rejectedIds.length > 0) {
          this.log.warn(
            { rejected: res.rejected.slice(0, 5), count: rejectedIds.length },
            'cloud rejected events',
          );
        }
        // Accepted and permanently rejected both leave the spool; only unmentioned ids stay.
        this.spool.ack([...accepted, ...rejectedIds]);
        this.delivered += accepted.size;
        this.status = this.spool.size() > batchSize ? 'backlogged' : 'ok';
        this.lastError = undefined;
        backoff = minMs;
        if (accepted.size === 0 && rejectedIds.length === 0) {
          // Nothing acknowledged: avoid a hot loop.
          await sleep(backoff, signal);
          backoff = Math.min(maxMs, backoff * 2);
        }
      } catch (err) {
        const e = err as Error;
        this.lastError = e.message;
        if (err instanceof CloudAuthError) {
          this.status = 'auth-failed';
          this.held = true;
          this.log.error({ err: e.message }, 'cloud rejected collector credentials; holding spool');
          continue;
        }
        this.status = this.spool.size() > 0 ? 'backlogged' : 'unreachable';
        this.log.warn(
          { err: e.message, backoffMs: backoff, spool: this.spool.size() },
          'delivery failed',
        );
        await sleep(backoff, signal);
        backoff = Math.min(maxMs, backoff * 2);
      }
    }
  }

  private waitForPoke(
    signal: AbortSignal,
    ms: number,
    sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.wake = undefined;
        resolve();
      };
      this.wake = finish;
      void sleep(ms, signal).then(finish);
    });
  }
}
