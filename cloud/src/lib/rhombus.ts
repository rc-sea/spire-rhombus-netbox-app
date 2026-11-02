/**
 * Thin typed client for the Rhombus REST API (api2.rhombussystems.com).
 * Server-only: holds the API key. `fetch` is injectable for tests.
 */
import type { Seekpoint } from './seekpoint';

export class RhombusError extends Error {
  override name = 'RhombusError';
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface RhombusClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RhombusCamera {
  uuid: string;
  name: string;
  locationUuid?: string;
}

interface RhombusEnvelope {
  error?: boolean;
  errorCode?: string | null;
  errorMsg?: string | null;
}

export class RhombusClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RhombusClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api2.rhombussystems.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** POST /api/camera/createCustomFootageSeekpoints — one call per camera. */
  async createSeekpoints(cameraUuid: string, points: Seekpoint[]): Promise<void> {
    await this.post('/api/camera/createCustomFootageSeekpoints', {
      cameraUuid,
      footageSeekPoints: points.map((p) => ({
        name: p.name,
        timestampMs: p.timestampMs,
        color: p.color,
        description: p.description,
        displayOverlay: p.displayOverlay,
      })),
    });
  }

  /** POST /api/camera/getMinimalCameraStateList */
  async listCameras(): Promise<RhombusCamera[]> {
    const body = (await this.post('/api/camera/getMinimalCameraStateList', {})) as {
      cameraStates?: { uuid: string; name: string; locationUuid?: string }[];
    };
    return (body.cameraStates ?? []).map((c) => ({
      uuid: c.uuid,
      name: c.name,
      ...(c.locationUuid ? { locationUuid: c.locationUuid } : {}),
    }));
  }

  /** POST /api/org/generateFederatedSessionToken — short-lived token for a browser player. */
  async federatedSessionToken(durationSec = 3600): Promise<string> {
    const body = (await this.post('/api/org/generateFederatedSessionToken', {
      durationSec,
    })) as { federatedSessionToken?: string };
    if (!body.federatedSessionToken)
      throw new RhombusError('no federatedSessionToken in response', 200, null, false);
    return body.federatedSessionToken;
  }

  /** POST /api/camera/getMediaUris */
  async mediaUris(cameraUuid: string): Promise<Record<string, unknown>> {
    return (await this.post('/api/camera/getMediaUris', { cameraUuid })) as Record<string, unknown>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'x-auth-scheme': 'api-token',
          'x-auth-apikey': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new RhombusError(`${path}: ${(err as Error).message}`, 0, null, true);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let json: RhombusEnvelope & Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as RhombusEnvelope & Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    if (res.status === 429 || res.status >= 500) {
      throw new RhombusError(
        `${path}: HTTP ${res.status}`,
        res.status,
        json.errorCode ?? (res.status === 429 ? 'RATE_LIMITED' : null),
        true,
      );
    }
    if (res.status >= 400 || json.error === true) {
      throw new RhombusError(
        `${path}: ${json.errorCode ?? `HTTP ${res.status}`}${json.errorMsg ? ` — ${json.errorMsg}` : ''}`,
        res.status,
        json.errorCode ?? null,
        false,
      );
    }
    return json;
  }
}
