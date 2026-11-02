/**
 * Typed wrappers for the read-only NBAPI commands the collector uses.
 * Response shapes follow the April 2024 guide (API-UG-22); see docs/netbox-nbapi.md.
 */
import type { NbapiClient } from './client.js';
import { NbapiError, type NbapiResponse } from './types.js';

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Tags like READER are parsed as arrays because they repeat in list commands;
  // inside an ACCESS record they are scalars.
  if (Array.isArray(v) && v.length === 1) return str(v[0]);
  return undefined;
}

function rec(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function arr(v: unknown): Json[] {
  if (Array.isArray(v)) return v.filter((x): x is Json => rec(x) !== undefined);
  const r = rec(v);
  return r ? [r] : [];
}

function expectSuccess(res: NbapiResponse, command: string): Json {
  if (res.code !== 'SUCCESS') {
    throw new NbapiError(
      `${command} returned ${res.code ?? 'no CODE'}${res.errMsg ? `: ${res.errMsg}` : ''}`,
      command,
      res,
    );
  }
  return res.details ?? {};
}

export async function pingApp(c: NbapiClient): Promise<boolean> {
  const res = await c.call('PingApp');
  return res.code === 'SUCCESS';
}

export async function getApiVersion(c: NbapiClient): Promise<string> {
  const d = expectSuccess(await c.call('GetAPIVersion'), 'GetAPIVersion');
  return str(d.APIVERSION) ?? '';
}

export interface Reader {
  key: string;
  name: string;
  description?: string;
  /** PORTAL ORDER when returned inside GetPortals (1 = first/incoming, 2 = second). */
  order?: number;
}

export interface Portal {
  key: string;
  name: string;
  readers: Reader[];
}

export interface Elevator {
  key: string;
  name: string;
  raw: Json;
}

export interface Floor {
  key: string;
  name: string;
  raw: Json;
}

/** Page through a STARTFROMKEY/NEXTKEY list command. */
async function paged<T>(
  c: NbapiClient,
  command: 'GetReaders' | 'GetPortals' | 'GetElevators' | 'GetFloors',
  pick: (details: Json) => T[],
): Promise<T[]> {
  const out: T[] = [];
  let startFromKey: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const params = startFromKey !== undefined ? { STARTFROMKEY: startFromKey } : undefined;
    const d = expectSuccess(await c.call(command, params), command);
    out.push(...pick(d));
    const next = str(d.NEXTKEY);
    if (!next || next === '-1' || Number(next) <= 0) break;
    if (next === startFromKey) break; // defensive: NetBox should never repeat a key
    startFromKey = next;
  }
  return out;
}

function readerFrom(r: Json): Reader {
  const reader: Reader = { key: str(r.READERKEY) ?? '', name: str(r.NAME) ?? '' };
  const desc = str(r.DESCRIPTION);
  if (desc) reader.description = desc;
  const order = str(r['PORTAL ORDER'] ?? r.PORTALORDER ?? r.PORTAL_ORDER);
  if (order && !Number.isNaN(Number(order))) reader.order = Number(order);
  return reader;
}

export function getReaders(c: NbapiClient): Promise<Reader[]> {
  return paged(c, 'GetReaders', (d) => arr(rec(d.READERS)?.READER).map(readerFrom));
}

export function getPortals(c: NbapiClient): Promise<Portal[]> {
  return paged(c, 'GetPortals', (d) =>
    arr(rec(d.PORTALS)?.PORTAL).map((p) => ({
      key: str(p.PORTALKEY) ?? '',
      name: str(p.NAME) ?? '',
      readers: arr(rec(p.READERS)?.READER).map(readerFrom),
    })),
  );
}

export function getElevators(c: NbapiClient): Promise<Elevator[]> {
  return paged(c, 'GetElevators', (d) =>
    arr(rec(d.ELEVATORS)?.ELEVATOR).map((e) => ({
      key: str(e.ELEVATORKEY) ?? str(e.KEY) ?? '',
      name: str(e.NAME) ?? '',
      raw: e,
    })),
  );
}

export function getFloors(c: NbapiClient): Promise<Floor[]> {
  return paged(c, 'GetFloors', (d) =>
    arr(rec(d.FLOORS)?.FLOOR).map((f) => ({
      key: str(f.FLOORKEY) ?? str(f.KEY) ?? '',
      name: str(f.NAME) ?? '',
      raw: f,
    })),
  );
}

/** Configured event names (ListEvents on the Event API address). */
export async function listEvents(c: NbapiClient): Promise<string[]> {
  const d = expectSuccess(await c.call('ListEvents'), 'ListEvents');
  const names: string[] = [];
  const events = rec(d.EVENTS);
  for (const e of arr(events?.EVENT)) {
    const n = str(e.NAME) ?? str(e.EVENTNAME) ?? str(e['#text']);
    if (n) names.push(n);
  }
  for (const n of arr(d.EVENTNAME)) {
    const t = str(n['#text']);
    if (t) names.push(t);
  }
  if (Array.isArray(d.EVENTNAME)) {
    for (const n of d.EVENTNAME) if (typeof n === 'string') names.push(n);
  }
  return [...new Set(names)];
}

export interface AccessRecord {
  logId: string;
  personId?: string;
  reader?: string;
  readerKey?: string;
  portalKey?: string;
  portalName?: string;
  /** System date/time string exactly as returned (tzoffset form when requested). */
  dttm?: string;
  nodeDttm?: string;
  /** 1 = valid access; otherwise a reason type. */
  type?: string;
  reason?: string;
}

export interface AccessHistoryPage {
  records: AccessRecord[];
  /** -1 when there is nothing more; undefined on NOT FOUND. */
  nextLogId?: string;
  notFound: boolean;
}

export interface AccessHistoryQuery {
  afterLogId?: string;
  startLogId?: string;
  maxRecords?: number;
  oldestDttm?: string;
  newestDttm?: string;
  order?: 'ASCENDING' | 'DESCENDING';
}

/** One page of GetAccessHistory. Use `afterLogId` for forward catch-up. */
export async function getAccessHistory(
  c: NbapiClient,
  q: AccessHistoryQuery = {},
): Promise<AccessHistoryPage> {
  const params: Record<string, string | number | undefined> = {
    AFTERLOGID: q.afterLogId,
    STARTLOGID: q.startLogId,
    MAXRECORDS: q.maxRecords,
    OLDESTDTTM: q.oldestDttm,
    NEWESTDTTM: q.newestDttm,
    ORDER: q.order,
  };
  const res = await c.call('GetAccessHistory', params);
  if (res.code === 'NOT FOUND') return { records: [], notFound: true };
  const d = expectSuccess(res, 'GetAccessHistory');
  const records = arr(rec(d.ACCESSES)?.ACCESS).map((a) => {
    const r: AccessRecord = { logId: str(a.LOGID) ?? '' };
    const set = (k: Exclude<keyof AccessRecord, 'logId'>, v: unknown) => {
      const s = str(v);
      if (s !== undefined && s !== '') r[k] = s;
    };
    set('personId', a.PERSONID);
    set('reader', a.READER);
    set('readerKey', a.READERKEY);
    set('portalKey', a.PORTALKEY);
    set('portalName', a.PORTALNAME);
    set('dttm', a.DTTM);
    set('nodeDttm', a.NODEDTTM);
    set('type', a.TYPE);
    set('reason', a.REASON);
    return r;
  });
  const page: AccessHistoryPage = { records, notFound: false };
  const next = str(d.NEXTLOGID);
  if (next !== undefined) page.nextLogId = next;
  return page;
}
