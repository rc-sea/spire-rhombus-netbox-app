/**
 * Bridge event schema shared by the on-prem collector and the cloud service.
 *
 * Everything that crosses the collector → cloud boundary is defined here and
 * validated with zod on both sides. Bump SCHEMA_VERSION on any breaking change.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

/** Normalized event kinds. Unknown NetBox DESCNAME values map to `other`. */
export const EventKind = z.enum([
  'access-granted',
  'access-denied',
  'access-not-completed',
  'door-forced',
  'door-held',
  'door-restored',
  'door-unlock',
  'elevator-granted',
  'elevator-denied',
  'elevator-free-access',
  'elevator-not-completed',
  'event-activated',
  'event-normal',
  'netbox-health',
  'other',
]);
export type EventKind = z.infer<typeof EventKind>;

/** Where the collector got the event from. */
export const EventSource = z.enum(['stream', 'history']);
export type EventSource = z.infer<typeof EventSource>;

/**
 * Mapping from NetBox activity DESCNAME to bridge kind.
 * Source: NBAPI guide API-UG-22 (April 2024), "Event Descriptions", pp. 29–33.
 */
export const DESCNAME_TO_KIND: Readonly<Record<string, EventKind>> = Object.freeze({
  'Access Granted': 'access-granted',
  'Invalid Access': 'access-denied',
  'Access Not Completed': 'access-not-completed',
  'Access Denied Because Radio Busy': 'access-denied',
  'Portal Forced Open': 'door-forced',
  'Portal Held Open': 'door-held',
  'Portal Restored': 'door-restored',
  'Momentary Unlock': 'door-unlock',
  'Request Momentary Unlock': 'door-unlock',
  Unlock: 'door-unlock',
  Relock: 'door-restored',
  'Elevator Access Granted': 'elevator-granted',
  'Elevator Access Denied': 'elevator-denied',
  'Elevator Free Access': 'elevator-free-access',
  'Elevator Access Not Completed': 'elevator-not-completed',
  'Event Activated': 'event-activated',
  'Event Normal': 'event-normal',
  // NetBox-reported health items: surfaced on the health page, never published to Rhombus.
  'Network Node Timeout': 'netbox-health',
  'Network Node Disconnect': 'netbox-health',
  'Network Node Restored': 'netbox-health',
  'Network Node Connected': 'netbox-health',
  'Network Controller Startup': 'netbox-health',
  'Network Controller Shutdown': 'netbox-health',
  'Reader Communication Alarm': 'netbox-health',
  'Reader Communication Normal': 'netbox-health',
  'System License Expired': 'netbox-health',
  'System License Expires in 30 Days': 'netbox-health',
  'System License Expires in 60 Days': 'netbox-health',
});

export function kindForDescName(descName: string | undefined | null): EventKind {
  if (!descName) return 'other';
  return DESCNAME_TO_KIND[descName.trim()] ?? 'other';
}

/** Raw NetBox tag values we keep. All optional: not every event carries every tag. */
export const NetBoxTags = z
  .object({
    activityId: z.string().optional(),
    logId: z.string().optional(),
    descName: z.string().optional(),
    detail: z.string().optional(),
    personId: z.string().optional(),
    personName: z.string().optional(),
    portalName: z.string().optional(),
    portalKey: z.string().optional(),
    readerName: z.string().optional(),
    readerKey: z.string().optional(),
    acName: z.string().optional(),
    nodeName: z.string().optional(),
    nodeAddress: z.string().optional(),
    partitionName: z.string().optional(),
    eventName: z.string().optional(),
    eventPriority: z.string().optional(),
    locationName: z.string().optional(),
    threatName: z.string().optional(),
    /** Controller date/time exactly as NetBox sent it (local or tzoffset form). */
    cdt: z.string().optional(),
    /** Node date/time exactly as NetBox sent it. */
    ndt: z.string().optional(),
    /** GetAccessHistory TYPE (1 = valid access) and REASON code, when from history. */
    accessType: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type NetBoxTags = z.infer<typeof NetBoxTags>;

const isoUtc = z.string().datetime({ offset: false });

export const BridgeEvent = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Idempotency key. `${collectorId}:${source}:${activityId|logId}`. */
    id: z.string().min(1).max(200),
    collectorId: z.string().min(1).max(100),
    source: EventSource,
    kind: EventKind,
    /** When the event happened, UTC ISO-8601 with Z. */
    occurredAt: isoUtc,
    /** When the collector received it, UTC ISO-8601 with Z. */
    receivedAt: isoUtc,
    netbox: NetBoxTags,
  })
  .strict();
export type BridgeEvent = z.infer<typeof BridgeEvent>;

export const IngestRequest = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    events: z.array(BridgeEvent).min(1).max(100),
  })
  .strict();
export type IngestRequest = z.infer<typeof IngestRequest>;

export const IngestResponse = z
  .object({
    accepted: z.array(z.string()),
    rejected: z.array(z.object({ id: z.string(), error: z.string() })),
  })
  .strict();
export type IngestResponse = z.infer<typeof IngestResponse>;

export const NetBoxStatus = z.enum([
  'connected',
  'stream-down',
  'auth-failed',
  'api-version-mismatch',
  'unreachable',
]);
export type NetBoxStatus = z.infer<typeof NetBoxStatus>;

export const CloudStatus = z.enum(['ok', 'backlogged', 'auth-failed', 'unreachable']);
export type CloudStatus = z.infer<typeof CloudStatus>;

export const Heartbeat = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    collectorId: z.string().min(1),
    collectorVersion: z.string(),
    sentAt: isoUtc,
    netboxStatus: NetBoxStatus,
    nbapiVersionConfigured: z.union([z.literal(1), z.literal(2)]),
    nbapiVersionReported: z.string().nullable(),
    lastEventAt: isoUtc.nullable(),
    lastReconcileAt: isoUtc.nullable(),
    lastReconcileResult: z
      .object({ newRecords: z.number().int().nonnegative(), error: z.string().nullable() })
      .nullable(),
    spoolSize: z.number().int().nonnegative(),
    cloudStatus: CloudStatus,
    hostUptimeSec: z.number().nonnegative(),
  })
  .strict();
export type Heartbeat = z.infer<typeof Heartbeat>;

/** Actions the cloud asks the collector to perform, returned in the heartbeat response. */
export const CollectorAction = z.enum(['refresh-inventory']);
export type CollectorAction = z.infer<typeof CollectorAction>;

export const HeartbeatResponse = z.object({ actions: z.array(CollectorAction) }).strict();
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const InventoryItemType = z.enum(['reader', 'portal', 'elevator', 'floor', 'event']);
export type InventoryItemType = z.infer<typeof InventoryItemType>;

export const InventoryItem = z
  .object({
    type: InventoryItemType,
    /** NetBox key (READERKEY, PORTALKEY, …) as a string; event names use the name itself. */
    key: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    /** For portals: the readers attached, with PORTAL ORDER. */
    readers: z
      .array(z.object({ key: z.string(), name: z.string(), order: z.number().int().optional() }))
      .optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type InventoryItem = z.infer<typeof InventoryItem>;

export const InventorySnapshot = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    collectorId: z.string().min(1),
    takenAt: isoUtc,
    items: z.array(InventoryItem),
  })
  .strict();
export type InventorySnapshot = z.infer<typeof InventorySnapshot>;

/**
 * Parse a NetBox timestamp into a UTC ISO string.
 *
 * NetBox returns `YYYY-MM-DD HH:MM:SS` in site-local time by default, or
 * `YYYY-MM-DD HH:MM:SS ±HHMM` when the request carried `dateformat="tzoffset"`.
 * Stream CDT values may carry fractional seconds (`17:00:53.942949`).
 * When no offset is present, `siteOffsetMinutes` (minutes east of UTC) is applied.
 */
export function netboxTimeToIso(value: string, siteOffsetMinutes: number): string {
  const m = value
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*([+-])(\d{2})(\d{2}))?$/,
    );
  if (!m) throw new Error(`Unparseable NetBox timestamp: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s, frac, sign, oh, om] = m;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms,
  );
  let offsetMin: number;
  if (sign && oh && om) {
    offsetMin = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  } else {
    offsetMin = siteOffsetMinutes;
  }
  return new Date(asUtc - offsetMin * 60_000).toISOString();
}

/**
 * Offset in minutes east of UTC for an IANA timezone at a given instant,
 * e.g. America/Los_Angeles → -480 (PST) or -420 (PDT).
 */
export function tzOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}
