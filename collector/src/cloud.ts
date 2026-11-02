/**
 * The collector's view of the cloud service: three outbound POSTs with a
 * bearer secret. Nothing listens; the cloud never calls us.
 */
import {
  type CloudStatus,
  type Heartbeat,
  type HeartbeatResponse,
  HeartbeatResponse as HeartbeatResponseSchema,
  type IngestRequest,
  type IngestResponse,
  IngestResponse as IngestResponseSchema,
  type InventorySnapshot,
} from '@spire/shared';
import { type Dispatcher, request } from 'undici';

export class CloudAuthError extends Error {
  override name = 'CloudAuthError';
}
export class CloudUnavailableError extends Error {
  override name = 'CloudUnavailableError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface CloudClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  dispatcher?: Dispatcher;
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(opts: CloudClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.dispatcher = opts.dispatcher;
  }

  ingest(body: IngestRequest): Promise<IngestResponse> {
    return this.post('/api/ingest/events', body, IngestResponseSchema.parse);
  }

  heartbeat(body: Heartbeat): Promise<HeartbeatResponse> {
    return this.post('/api/ingest/heartbeat', body, HeartbeatResponseSchema.parse);
  }

  inventory(body: InventorySnapshot): Promise<void> {
    return this.post('/api/ingest/inventory', body, () => undefined);
  }

  private async post<T>(path: string, body: unknown, parse: (json: unknown) => T): Promise<T> {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      throw new CloudUnavailableError(`${path}: ${(err as Error).message}`);
    }
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new CloudAuthError(`${path}: HTTP ${res.statusCode}`);
    }
    if (res.statusCode >= 500 || res.statusCode === 429) {
      throw new CloudUnavailableError(`${path}: HTTP ${res.statusCode}`, res.statusCode);
    }
    if (res.statusCode >= 400) {
      throw new Error(`${path}: HTTP ${res.statusCode} ${text.slice(0, 200)}`);
    }
    return parse(text ? JSON.parse(text) : undefined);
  }
}

export function statusFromError(err: unknown): CloudStatus {
  if (err instanceof CloudAuthError) return 'auth-failed';
  if (err instanceof CloudUnavailableError) return 'unreachable';
  return 'unreachable';
}
