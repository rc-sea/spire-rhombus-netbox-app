/**
 * NBAPI types and the read-only command allow-list.
 *
 * The allow-list is the code-level guarantee behind the spec requirement
 * "Collector never writes to NetBox". Anything not listed here is refused by
 * the client before a request is built.
 */

export const READ_ONLY_COMMANDS = [
  'Login',
  'Logout',
  'PingApp',
  'GetAPIVersion',
  'GetReaders',
  'GetPortals',
  'GetElevators',
  'GetFloors',
  'ListEvents',
  'GetAccessHistory',
  'GetEventHistory',
  'StreamEvents',
] as const;
export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];

const allowSet: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS);
export function isReadOnlyCommand(name: string): name is ReadOnlyCommand {
  return allowSet.has(name);
}

/** Commands that are served from the Event API address rather than /goforms/nbapi. */
export const EVENT_API_COMMANDS: ReadonlySet<string> = new Set(['ListEvents', 'TriggerEvent']);

export type NbapiVersion = 1 | 2;

export interface NbapiClientOptions {
  /** e.g. "http://192.168.10.5" or "https://netbox.spire.local:8443" (no trailing slash). */
  baseUrl: string;
  username: string;
  password: string;
  /** Which NBAPI version NetBox is expected to speak. Logged and compared with GetAPIVersion. */
  version: NbapiVersion;
  /** How the XML is sent: raw body (default per the guide) or a form field named APIcommand. */
  bodyMode?: 'raw' | 'form';
  /** Also send the session id as a `.sessionid` cookie (needed by event endpoints). Default true. */
  sessionCookie?: boolean;
  /** Request timeout for ordinary commands, ms. Default 15000. */
  timeoutMs?: number;
  /** Paths, overridable for odd deployments. */
  paths?: { commands?: string; events?: string; stream?: string };
  /** Optional undici Dispatcher (used by tests and for custom TLS/CA settings). */
  dispatcher?: import('undici').Dispatcher;
}

/** Parsed shape of a NETBOX response document. */
export interface NbapiResponse {
  sessionId?: string;
  command?: string;
  /** SUCCESS | FAIL | NOT FOUND; undefined on APIERROR. */
  code?: string;
  apiError?: number;
  /** DETAILS block as parsed JSON (tag names uppercase as NetBox sends them). */
  details?: Record<string, unknown>;
  /** ERRMSG when present under DETAILS. */
  errMsg?: string;
}

export class NbapiError extends Error {
  override name = 'NbapiError';
  constructor(
    message: string,
    readonly command: string,
    readonly response?: NbapiResponse,
  ) {
    super(message);
  }
}

export class NbapiAuthError extends NbapiError {
  override name = 'NbapiAuthError';
}

export class NbapiDisallowedCommandError extends Error {
  override name = 'NbapiDisallowedCommandError';
  constructor(readonly command: string) {
    super(`NBAPI command "${command}" is not on the read-only allow-list and was not sent`);
  }
}

/** APIERROR codes per guide p. 9. */
export const API_ERROR_TEXT: Readonly<Record<number, string>> = {
  1: 'The API failed to initialize',
  2: 'The API is not enabled on the system (Data Integration tab → Enabled)',
  3: 'The call contains an invalid API command',
  4: 'The API was unable to parse the command request',
  5: 'Authentication failure',
  6: 'The XML code contains an unknown command',
};
