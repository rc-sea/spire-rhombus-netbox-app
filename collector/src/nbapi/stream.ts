/**
 * StreamEvents: a long-lived NBAPI connection that yields NetBox activity.
 *
 * Guarantees (see specs/netbox-event-collection):
 * - exactly one open stream connection per EventStream instance;
 * - a 30 s silence (no keep-alive, no event) is treated as a dead connection;
 * - reconnects with exponential backoff (1 s → 60 s) until stopped;
 * - status changes are reported through `onStatus`.
 */
import { request } from 'undici';
import type { NbapiClient } from './client.js';
import { buildStreamCommand, parseResponse, splitStreamDocuments } from './xml.js';

export type StreamStatus = 'connecting' | 'connected' | 'stream-down' | 'stopped';

export interface StreamEvent {
  /** Tag values as NetBox sent them, uppercase keys. */
  tags: Record<string, string>;
  /** Local receive time. */
  receivedAt: Date;
}

export interface EventStreamOptions {
  /** TAGNAMES to request, with optional FILTER values per tag. */
  tags: Record<string, string[]>;
  /** Treat the connection as dead after this long without any bytes. Default 30000. */
  silenceTimeoutMs?: number;
  /** Backoff bounds. Defaults 1000 and 60000. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  onStatus?: (status: StreamStatus, detail?: string) => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_STREAM_TAGS: Record<string, string[]> = {
  ACTIVITYID: [],
  DESCNAME: [],
  CDT: [],
  NDT: [],
  PERSONID: [],
  PERSONNAME: [],
  PORTALNAME: [],
  RDRNAME: [],
  ACNAME: [],
  DETAIL: [],
  NODENAME: [],
  NODEADDRESS: [],
  PARTNAME: [],
  EVTNAME: [],
  EVTPRIO: [],
  LOCATIONNAME: [],
  THREATNAME: [],
  UCBITLENGTH: [],
};

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

/** Extract tag values from a parsed EVENT block (strings only). */
function tagsOf(event: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!event || typeof event !== 'object') return out;
  for (const [k, v] of Object.entries(event as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  return out;
}

export class EventStream {
  private readonly controller = new AbortController();
  private connectionOpen = false;

  constructor(
    private readonly client: NbapiClient,
    private readonly opts: EventStreamOptions,
  ) {}

  /** Stop streaming; the iterator finishes after the current connection closes. */
  stop(): void {
    this.controller.abort();
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Yields events for as long as the stream is not stopped. Reconnects on
   * any failure. Never throws for transient faults; auth failures are reported
   * via onStatus and retried after backoff (the client re-logs-in).
   */
  async *events(): AsyncGenerator<StreamEvent, void, void> {
    const signal = this.controller.signal;
    const sleep = this.opts.sleep ?? defaultSleep;
    const minMs = this.opts.backoffMinMs ?? 1_000;
    const maxMs = this.opts.backoffMaxMs ?? 60_000;
    let backoff = minMs;
    while (!signal.aborted) {
      try {
        if (!this.client.isLoggedIn) await this.client.login();
        this.status('connecting');
        let sawData = false;
        for await (const ev of this.openOnce(signal)) {
          if (!sawData) {
            sawData = true;
            backoff = minMs;
          }
          yield ev;
        }
        // Clean close by NetBox: reconnect promptly.
        if (!signal.aborted) this.status('stream-down', 'connection closed');
      } catch (err) {
        if (signal.aborted) break;
        this.status('stream-down', (err as Error).message);
      }
      if (signal.aborted) break;
      await sleep(backoff, signal);
      backoff = Math.min(maxMs, backoff * 2);
    }
    this.status('stopped');
  }

  /** One connection lifetime. Yields events; returns when the connection ends. */
  private async *openOnce(signal: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    if (this.connectionOpen) {
      throw new Error('stream connection already open');
    }
    this.connectionOpen = true;
    const silenceMs = this.opts.silenceTimeoutMs ?? 30_000;
    const connAbort = new AbortController();
    const onStop = () => connAbort.abort();
    signal.addEventListener('abort', onStop, { once: true });
    let silenceTimer: NodeJS.Timeout | undefined;
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(
        () => connAbort.abort(new Error(`no data for ${silenceMs} ms`)),
        silenceMs,
      );
    };
    try {
      const xml = buildStreamCommand(this.opts.tags);
      const res = await request(this.client.streamUrl, {
        method: 'POST',
        headers: this.client.streamHeaders(),
        body: this.client.encodeBody(xml),
        dispatcher: this.client.dispatcherForStream,
        signal: connAbort.signal,
        headersTimeout: silenceMs,
        bodyTimeout: 0,
      });
      if (res.statusCode >= 400) {
        await res.body.text().catch(() => undefined);
        throw new Error(`HTTP ${res.statusCode} from stream endpoint`);
      }
      let connected = false;
      let buffer = '';
      armSilence();
      res.body.setEncoding('utf8');
      for await (const chunk of res.body) {
        armSilence();
        buffer += chunk as string;
        const { docs, rest } = splitStreamDocuments(buffer);
        buffer = rest;
        for (const doc of docs) {
          let parsed: ReturnType<typeof parseResponse>;
          try {
            parsed = parseResponse(doc);
          } catch {
            continue; // a malformed keep-alive is not fatal
          }
          if (parsed.apiError !== undefined) {
            throw new Error(`APIERROR ${parsed.apiError} on stream`);
          }
          if (!connected) {
            connected = true;
            this.status('connected');
          }
          const events = parsed.details?.EVENT;
          if (!events) continue; // keep-alive
          const list = Array.isArray(events) ? events : [events];
          const receivedAt = new Date();
          for (const e of list) yield { tags: tagsOf(e), receivedAt };
        }
      }
    } finally {
      if (silenceTimer) clearTimeout(silenceTimer);
      signal.removeEventListener('abort', onStop);
      this.connectionOpen = false;
    }
  }

  private status(s: StreamStatus, detail?: string): void {
    this.opts.onStatus?.(s, detail);
  }
}
