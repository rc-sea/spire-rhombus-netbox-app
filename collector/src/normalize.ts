/**
 * Turn NetBox activity (stream events and access-history records) into
 * BridgeEvents with stable idempotency ids.
 *
 * Id scheme: the stream identifies activity by ACTIVITYID and access history
 * by LOGID, which are different id spaces, so the same fob read seen on both
 * paths would get two ids. For access events we therefore derive the id from
 * content — reader, person and the second it happened — so stream and history
 * agree. Everything else (door forced, elevator free access, event activated…)
 * only ever arrives on the stream and keeps ACTIVITYID.
 */
import {
  type BridgeEvent,
  type EventKind,
  kindForDescName,
  type NetBoxTags,
  netboxTimeToIso,
  SCHEMA_VERSION,
  tzOffsetMinutes,
} from '@spire/shared';
import type { AccessRecord } from './nbapi/commands.js';
import type { StreamEvent } from './nbapi/stream.js';

export interface NormalizeContext {
  collectorId: string;
  siteTimezone: string;
}

const ACCESS_KINDS: ReadonlySet<EventKind> = new Set([
  'access-granted',
  'access-denied',
  'access-not-completed',
]);

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Content-derived id for access events so stream and history collide on purpose. */
export function accessEventId(
  collectorId: string,
  kind: EventKind,
  reader: string | undefined,
  personId: string | undefined,
  personName: string | undefined,
  occurredAt: string,
): string {
  const sec = occurredAt.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  const who = norm(personId) || norm(personName) || 'unknown';
  return `${collectorId}:acc:${kind}:${norm(reader) || 'unknown'}:${who}:${sec}`;
}

function toIso(value: string | undefined, ctx: NormalizeContext, fallback: Date): string {
  if (!value) return fallback.toISOString();
  try {
    return netboxTimeToIso(value, tzOffsetMinutes(ctx.siteTimezone, fallback));
  } catch {
    return fallback.toISOString();
  }
}

/** Normalize one StreamEvents EVENT. */
export function fromStreamEvent(ev: StreamEvent, ctx: NormalizeContext): BridgeEvent {
  const t = ev.tags;
  const kind = kindForDescName(t.DESCNAME);
  const occurredAt = toIso(t.CDT ?? t.NDT, ctx, ev.receivedAt);
  const reader = t.RDRNAME;
  const netbox: NetBoxTags = {};
  const put = (k: keyof NetBoxTags, v: string | undefined) => {
    if (v !== undefined && v !== '') netbox[k] = v;
  };
  put('activityId', t.ACTIVITYID);
  put('descName', t.DESCNAME);
  put('detail', t.DETAIL);
  put('personId', t.PERSONID);
  put('personName', t.PERSONNAME);
  put('portalName', t.PORTALNAME);
  put('readerName', reader);
  put('acName', t.ACNAME);
  put('nodeName', t.NODENAME);
  put('nodeAddress', t.NODEADDRESS);
  put('partitionName', t.PARTNAME);
  put('eventName', t.EVTNAME);
  put('eventPriority', t.EVTPRIO);
  put('locationName', t.LOCATIONNAME);
  put('threatName', t.THREATNAME);
  put('cdt', t.CDT);
  put('ndt', t.NDT);

  const id = ACCESS_KINDS.has(kind)
    ? accessEventId(ctx.collectorId, kind, reader, t.PERSONID, t.PERSONNAME, occurredAt)
    : `${ctx.collectorId}:act:${t.ACTIVITYID ?? `${occurredAt}:${norm(t.DESCNAME)}`}`;

  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    collectorId: ctx.collectorId,
    source: 'stream',
    kind,
    occurredAt,
    receivedAt: ev.receivedAt.toISOString(),
    netbox,
  };
}

/**
 * Normalize one GetAccessHistory record. TYPE 1 is a valid access; anything
 * else is a denial with a REASON code (guide: "Type Element").
 */
export function fromAccessRecord(
  rec: AccessRecord,
  ctx: NormalizeContext,
  receivedAt: Date = new Date(),
): BridgeEvent {
  const kind: EventKind =
    rec.type === undefined || rec.type === '1' ? 'access-granted' : 'access-denied';
  const occurredAt = toIso(rec.dttm ?? rec.nodeDttm, ctx, receivedAt);
  const netbox: NetBoxTags = { logId: rec.logId };
  if (rec.personId) netbox.personId = rec.personId;
  if (rec.reader) netbox.readerName = rec.reader;
  if (rec.readerKey) netbox.readerKey = rec.readerKey;
  if (rec.portalKey) netbox.portalKey = rec.portalKey;
  if (rec.portalName) netbox.portalName = rec.portalName;
  if (rec.dttm) netbox.cdt = rec.dttm;
  if (rec.nodeDttm) netbox.ndt = rec.nodeDttm;
  if (rec.type) netbox.accessType = rec.type;
  if (rec.reason) netbox.reason = rec.reason;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: accessEventId(ctx.collectorId, kind, rec.reader, rec.personId, undefined, occurredAt),
    collectorId: ctx.collectorId,
    source: 'history',
    kind,
    occurredAt,
    receivedAt: receivedAt.toISOString(),
    netbox,
  };
}
