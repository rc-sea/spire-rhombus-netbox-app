/**
 * NbapiClient: session handling, the read-only allow-list, and the HTTP plumbing
 * for ordinary NBAPI commands. Typed command wrappers live in commands.ts and the
 * event stream in stream.ts.
 */
import { Agent, type Dispatcher, request } from 'undici';
import {
  API_ERROR_TEXT,
  EVENT_API_COMMANDS,
  isReadOnlyCommand,
  NbapiAuthError,
  type NbapiClientOptions,
  NbapiDisallowedCommandError,
  NbapiError,
  type NbapiPathFamily,
  type NbapiProbeResult,
  type NbapiResponse,
  PATH_FAMILIES,
} from './types.js';
import { buildCommand, type ParamNode, parseResponse } from './xml.js';

/** Thrown when NetBox answers HTTP 410 on a path: the other path family is in use. */
export class NbapiWrongPathError extends NbapiError {
  override name = 'NbapiWrongPathError';
}

export interface CallOptions {
  /** Do not attach a session (Login itself). */
  noSession?: boolean;
  /** Do not re-login and retry on auth failure (used by the retry itself). */
  noRetry?: boolean;
}

export class NbapiClient {
  readonly baseUrl: string;
  paths: { commands: string; events: string; stream: string };
  /** Configured expectation; 'auto' accepts whatever GetAPIVersion reports. */
  readonly version: 1 | 2 | 'auto';
  /** Path family in use; undefined until configured or probed. */
  pathFamily: NbapiPathFamily | undefined;
  /** Result of the last probe(), if any. */
  probeResult: NbapiProbeResult | undefined;
  private readonly pathOverrides: Partial<{ commands: string; events: string; stream: string }>;
  private readonly username: string;
  private readonly password: string;
  private readonly bodyMode: 'raw' | 'form';
  private readonly sessionCookie: boolean;
  private readonly timeoutMs: number;
  private readonly dispatcher: Dispatcher;
  private sessionId: string | undefined;
  private loginPromise: Promise<void> | undefined;

  constructor(opts: NbapiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.version = opts.version;
    this.pathOverrides = opts.paths ?? {};
    const family = opts.pathFamily ?? 'auto';
    // Until probed, 'auto' starts on legacy (the guide's paths); probe() corrects it.
    this.pathFamily = family === 'auto' ? undefined : family;
    this.paths = { ...PATH_FAMILIES[this.pathFamily ?? 'legacy'], ...this.pathOverrides };
    this.username = opts.username;
    this.password = opts.password;
    this.bodyMode = opts.bodyMode ?? 'raw';
    this.sessionCookie = opts.sessionCookie ?? true;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.dispatcher =
      opts.dispatcher ??
      new Agent({ connections: 4, headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs });
  }

  /** Current session id, if logged in. Exposed for the event stream. */
  get session(): string | undefined {
    return this.sessionId;
  }

  get isLoggedIn(): boolean {
    return this.sessionId !== undefined;
  }

  /** Switch path family (keeps explicit per-path overrides). Drops the session. */
  usePathFamily(family: NbapiPathFamily): void {
    this.pathFamily = family;
    this.paths = { ...PATH_FAMILIES[family], ...this.pathOverrides };
    this.sessionId = undefined;
  }

  /**
   * Find out which path family this NetBox serves and which API version it
   * reports. Tries the configured family first (or legacy, then nbws when
   * 'auto'), treating HTTP 410 and 404 as "not this family". Leaves the client
   * logged in on the working family.
   */
  async probe(): Promise<NbapiProbeResult> {
    const order: NbapiPathFamily[] = this.pathFamily
      ? [this.pathFamily, this.pathFamily === 'legacy' ? 'nbws' : 'legacy']
      : ['legacy', 'nbws'];
    const tried: NbapiProbeResult['tried'] = [];
    for (const family of order) {
      this.usePathFamily(family);
      try {
        await this.login();
        const res = await this.send('GetAPIVersion', undefined, { noRetry: true });
        const apiVersion = String(res.details?.APIVERSION ?? '');
        tried.push({ family, outcome: `ok (APIVERSION ${apiVersion || 'unknown'})` });
        this.probeResult = { pathFamily: family, apiVersion, tried };
        return this.probeResult;
      } catch (err) {
        const e = err as Error;
        tried.push({ family, outcome: e.message });
        // Auth and API-disabled errors are definitive: the path is right, the setup is not.
        if (err instanceof NbapiAuthError) throw err;
        if (err instanceof NbapiError && /APIERROR [12]\b/.test(e.message)) throw err;
        this.sessionId = undefined;
      }
    }
    throw new NbapiError(
      `No NBAPI path family answered: ${tried.map((t) => `${t.family}: ${t.outcome}`).join('; ')}`,
      'probe',
    );
  }

  /** Log in (idempotent; concurrent callers share one login). */
  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const res = await this.send(
        'Login',
        { USERNAME: this.username, PASSWORD: this.password },
        { noSession: true, noRetry: true },
      );
      if (res.code !== 'SUCCESS' || !res.sessionId) {
        throw new NbapiAuthError(`Login failed: ${describe(res)}`, 'Login', redactSession(res));
      }
      this.sessionId = res.sessionId;
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = undefined;
    }
  }

  async logout(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.send('Logout', undefined, { noRetry: true });
    } finally {
      this.sessionId = undefined;
    }
  }

  /**
   * Execute a read-only command. Logs in on first use, and on an auth failure
   * logs in again and retries once.
   */
  async call(name: string, params?: ParamNode, opts: CallOptions = {}): Promise<NbapiResponse> {
    if (!isReadOnlyCommand(name)) throw new NbapiDisallowedCommandError(name);
    if (!opts.noSession && !this.sessionId) await this.login();
    const canRetry = !opts.noRetry && !opts.noSession;
    let res: NbapiResponse;
    try {
      res = await this.send(name, params, opts);
    } catch (err) {
      if (err instanceof NbapiAuthError && canRetry) {
        return this.retryAfterRelogin(name, params, opts);
      }
      throw err;
    }
    if (isAuthFailure(res) && canRetry) {
      return this.retryAfterRelogin(name, params, opts);
    }
    return res;
  }

  /** Session was rejected: drop it, log in again, and send once more. */
  private async retryAfterRelogin(
    name: string,
    params: ParamNode | undefined,
    opts: CallOptions,
  ): Promise<NbapiResponse> {
    this.sessionId = undefined;
    await this.login();
    return this.send(name, params, { ...opts, noRetry: true });
  }

  /** Low-level: build, post, parse. Enforces the allow-list again as a belt-and-braces check. */
  private async send(
    name: string,
    params?: ParamNode,
    opts: CallOptions = {},
  ): Promise<NbapiResponse> {
    if (!isReadOnlyCommand(name)) throw new NbapiDisallowedCommandError(name);
    const xml = buildCommand(name, params, {
      sessionId: opts.noSession ? undefined : this.sessionId,
    });
    const path = EVENT_API_COMMANDS.has(name) ? this.paths.events : this.paths.commands;
    const text = await this.post(path, xml);
    let res: NbapiResponse;
    try {
      res = parseResponse(text);
    } catch (err) {
      throw new NbapiError(
        `Unparseable NBAPI response for ${name}: ${(err as Error).message}`,
        name,
      );
    }
    if (res.apiError !== undefined) {
      const msg = `APIERROR ${res.apiError}: ${API_ERROR_TEXT[res.apiError] ?? 'unknown'}`;
      if (res.apiError === 5) throw new NbapiAuthError(msg, name, res);
      if (res.apiError === 2 || res.apiError === 1) throw new NbapiError(msg, name, res);
      // 3, 4, 6 are command-shape problems; surface as plain errors.
      throw new NbapiError(msg, name, res);
    }
    return res;
  }

  /** POST the XML to a NetBox path and return the response body text. */
  async post(path: string, xml: string): Promise<string> {
    const headers: Record<string, string> = {
      accept: 'text/xml, application/xml, */*',
    };
    let body: string;
    if (this.bodyMode === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = `APIcommand=${encodeURIComponent(xml)}`;
    } else {
      headers['content-type'] = 'text/xml; charset=utf-8';
      body = xml;
    }
    if (this.sessionCookie && this.sessionId) headers.cookie = `.sessionid=${this.sessionId}`;
    const res = await request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body,
      dispatcher: this.dispatcher,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
    const text = await res.body.text();
    if (res.statusCode === 410 || res.statusCode === 404) {
      throw new NbapiWrongPathError(
        `HTTP ${res.statusCode} from ${path}: this NetBox does not serve NBAPI there (6.x uses /nbws/…)`,
        path,
      );
    }
    if (res.statusCode >= 400) {
      throw new NbapiError(`HTTP ${res.statusCode} from ${path}`, path);
    }
    return text;
  }

  /** Headers the event stream should send (session cookie), for stream.ts. */
  streamHeaders(): Record<string, string> {
    const h: Record<string, string> = { accept: 'text/xml, application/xml, */*' };
    h['content-type'] =
      this.bodyMode === 'form' ? 'application/x-www-form-urlencoded' : 'text/xml; charset=utf-8';
    if (this.sessionCookie && this.sessionId) h.cookie = `.sessionid=${this.sessionId}`;
    return h;
  }

  encodeBody(xml: string): string {
    return this.bodyMode === 'form' ? `APIcommand=${encodeURIComponent(xml)}` : xml;
  }

  get streamUrl(): string {
    return `${this.baseUrl}${this.paths.stream}`;
  }

  get dispatcherForStream(): Dispatcher {
    return this.dispatcher;
  }
}

function isAuthFailure(res: NbapiResponse): boolean {
  if (res.apiError === 5) return true;
  // Some commands answer FAIL with a session-related ERRMSG after a timeout.
  return res.code === 'FAIL' && /session|login|authenticat/i.test(res.errMsg ?? '');
}

function describe(res: NbapiResponse): string {
  if (res.apiError !== undefined) return `APIERROR ${res.apiError}`;
  return `${res.code ?? 'no CODE'}${res.errMsg ? ` (${res.errMsg})` : ''}`;
}

function redactSession(res: NbapiResponse): NbapiResponse {
  const { sessionId: _omit, ...rest } = res;
  return rest;
}
