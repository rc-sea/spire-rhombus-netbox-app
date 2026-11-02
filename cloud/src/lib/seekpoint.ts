/**
 * How a bridge event appears on a Rhombus timeline:
 * name ≤ 32 chars, description ≤ 100 chars, colour by kind.
 */
import type { BridgeEvent, EventKind } from '@spire/shared';
import type { SeekpointColor } from './db/repo';

export interface Seekpoint {
  name: string;
  timestampMs: number;
  color: SeekpointColor;
  description: string;
  displayOverlay: boolean;
}

const KIND_LABEL: Record<EventKind, string> = {
  'access-granted': 'Access',
  'access-denied': 'Denied',
  'access-not-completed': 'Not completed',
  'door-forced': 'FORCED',
  'door-held': 'Held open',
  'door-restored': 'Restored',
  'door-unlock': 'Unlock',
  'elevator-granted': 'Elevator',
  'elevator-denied': 'Elev denied',
  'elevator-free-access': 'Elev free',
  'elevator-not-completed': 'Elev n/c',
  'event-activated': 'Event',
  'event-normal': 'Event normal',
  'netbox-health': 'NetBox',
  other: 'NetBox',
};

const KIND_COLOR: Record<EventKind, SeekpointColor> = {
  'access-granted': 'BLUE',
  'access-denied': 'ORANGE',
  'access-not-completed': 'TAN',
  'door-forced': 'RED',
  'door-held': 'RED',
  'door-restored': 'TEAL',
  'door-unlock': 'TEAL',
  'elevator-granted': 'PURPLE',
  'elevator-denied': 'ORANGE',
  'elevator-free-access': 'PURPLE',
  'elevator-not-completed': 'TAN',
  'event-activated': 'GRAY',
  'event-normal': 'GRAY',
  'netbox-health': 'BLACK',
  other: 'GRAY',
};

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return max > 1 ? `${t.slice(0, max - 1)}…` : t.slice(0, max);
}

/** Short reader/portal label: the NetBox name, trimmed of common prefixes. */
function place(e: BridgeEvent): string {
  const n = e.netbox;
  const raw = n.readerName ?? n.portalName ?? n.nodeName ?? n.eventName ?? '';
  return (
    raw
      .replace(/\b(reader|door|portal)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || raw
  );
}

export function toSeekpoint(
  e: BridgeEvent,
  opts: { overlay: boolean; colorOverride?: SeekpointColor | null },
): Seekpoint {
  const label = KIND_LABEL[e.kind];
  const where = place(e);
  const name = clip(where ? `${label} · ${where}` : label, 32);
  const who = e.netbox.personName ?? (e.netbox.personId ? `ID ${e.netbox.personId}` : '');
  const detail = e.netbox.detail ?? e.netbox.reason ?? '';
  const bits = [who, e.netbox.descName, detail].filter((x) => x && x.length > 0);
  const description = clip(bits.join(' — ') || e.kind, 100);
  return {
    name,
    timestampMs: Date.parse(e.occurredAt),
    color: opts.colorOverride ?? KIND_COLOR[e.kind],
    description,
    displayOverlay: opts.overlay,
  };
}
