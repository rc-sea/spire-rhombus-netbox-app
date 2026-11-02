import { describe, expect, it } from 'vitest';
import {
  BridgeEvent,
  DESCNAME_TO_KIND,
  EventKind,
  Heartbeat,
  IngestRequest,
  InventorySnapshot,
  kindForDescName,
  netboxTimeToIso,
  SCHEMA_VERSION,
  tzOffsetMinutes,
} from '../src/index.js';

const baseEvent = {
  schemaVersion: SCHEMA_VERSION,
  id: 'spire-1:stream:976',
  collectorId: 'spire-1',
  source: 'stream',
  kind: 'access-granted',
  occurredAt: '2026-11-02T22:05:09.000Z',
  receivedAt: '2026-11-02T22:05:10.120Z',
  netbox: { activityId: '976', descName: 'Access Granted', readerName: 'Lobby Door' },
} as const;

describe('BridgeEvent', () => {
  it('accepts a well-formed event', () => {
    expect(BridgeEvent.parse(baseEvent)).toEqual(baseEvent);
  });

  it('accepts every declared kind', () => {
    for (const kind of EventKind.options) {
      expect(BridgeEvent.safeParse({ ...baseEvent, kind }).success).toBe(true);
    }
  });

  it('rejects unknown top-level fields', () => {
    const r = BridgeEvent.safeParse({ ...baseEvent, extra: 1 });
    expect(r.success).toBe(false);
  });

  it('rejects unknown netbox tag fields', () => {
    const r = BridgeEvent.safeParse({ ...baseEvent, netbox: { ...baseEvent.netbox, nope: 'x' } });
    expect(r.success).toBe(false);
  });

  it('rejects non-UTC timestamps', () => {
    const r = BridgeEvent.safeParse({ ...baseEvent, occurredAt: '2026-11-02T14:05:09-08:00' });
    expect(r.success).toBe(false);
  });

  it('rejects a wrong schema version', () => {
    const r = BridgeEvent.safeParse({ ...baseEvent, schemaVersion: 2 });
    expect(r.success).toBe(false);
  });
});

describe('IngestRequest', () => {
  it('bounds batches to 1..100 events', () => {
    expect(IngestRequest.safeParse({ schemaVersion: 1, events: [] }).success).toBe(false);
    const events = Array.from({ length: 101 }, (_, i) => ({ ...baseEvent, id: `e${i}` }));
    expect(IngestRequest.safeParse({ schemaVersion: 1, events }).success).toBe(false);
    expect(
      IngestRequest.safeParse({ schemaVersion: 1, events: events.slice(0, 100) }).success,
    ).toBe(true);
  });
});

describe('kindForDescName', () => {
  it('maps every documented DESCNAME to a declared kind', () => {
    for (const [name, kind] of Object.entries(DESCNAME_TO_KIND)) {
      expect(EventKind.options).toContain(kind);
      expect(kindForDescName(name)).toBe(kind);
    }
  });

  it('maps the core access and door events', () => {
    expect(kindForDescName('Access Granted')).toBe('access-granted');
    expect(kindForDescName('Invalid Access')).toBe('access-denied');
    expect(kindForDescName('Portal Forced Open')).toBe('door-forced');
    expect(kindForDescName('Portal Held Open')).toBe('door-held');
    expect(kindForDescName('Portal Restored')).toBe('door-restored');
    expect(kindForDescName('Momentary Unlock')).toBe('door-unlock');
    expect(kindForDescName('Elevator Access Granted')).toBe('elevator-granted');
    expect(kindForDescName('Elevator Free Access')).toBe('elevator-free-access');
  });

  it('maps unknown, empty and padded names', () => {
    expect(kindForDescName('Something New')).toBe('other');
    expect(kindForDescName('')).toBe('other');
    expect(kindForDescName(undefined)).toBe('other');
    expect(kindForDescName('  Access Granted ')).toBe('access-granted');
  });
});

describe('netboxTimeToIso', () => {
  it('uses the tzoffset when present', () => {
    expect(netboxTimeToIso('2026-11-02 14:05:09 -0800', 0)).toBe('2026-11-02T22:05:09.000Z');
    expect(netboxTimeToIso('2016-10-31 10:00:00 -0500', 0)).toBe('2016-10-31T15:00:00.000Z');
    expect(netboxTimeToIso('2026-06-01 09:00:00 +0100', 0)).toBe('2026-06-01T08:00:00.000Z');
  });

  it('falls back to the site offset when no tzoffset is present', () => {
    expect(netboxTimeToIso('2026-11-02 14:05:09', -480)).toBe('2026-11-02T22:05:09.000Z');
    expect(netboxTimeToIso('2026-07-04 12:00:00', -420)).toBe('2026-07-04T19:00:00.000Z');
  });

  it('keeps fractional seconds from stream CDT values', () => {
    expect(netboxTimeToIso('2016-11-03 17:00:53.942949', 0)).toBe('2016-11-03T17:00:53.943Z');
  });

  it('rejects garbage', () => {
    expect(() => netboxTimeToIso('yesterday', 0)).toThrow(/Unparseable/);
  });
});

describe('tzOffsetMinutes', () => {
  it('returns PST and PDT offsets for Los Angeles', () => {
    expect(tzOffsetMinutes('America/Los_Angeles', new Date('2026-01-15T12:00:00Z'))).toBe(-480);
    expect(tzOffsetMinutes('America/Los_Angeles', new Date('2026-07-15T12:00:00Z'))).toBe(-420);
  });
  it('returns 0 for UTC', () => {
    expect(tzOffsetMinutes('UTC')).toBe(0);
  });
});

describe('Heartbeat and InventorySnapshot', () => {
  it('accepts a healthy heartbeat', () => {
    const hb = Heartbeat.parse({
      schemaVersion: 1,
      collectorId: 'spire-1',
      collectorVersion: '0.1.0',
      sentAt: '2026-11-02T22:05:10.000Z',
      netboxStatus: 'connected',
      nbapiVersionConfigured: 1,
      nbapiVersionReported: '4.7',
      lastEventAt: null,
      lastReconcileAt: null,
      lastReconcileResult: null,
      spoolSize: 0,
      cloudStatus: 'ok',
      hostUptimeSec: 12,
    });
    expect(hb.netboxStatus).toBe('connected');
  });

  it('accepts an inventory with a portal and its readers', () => {
    const snap = InventorySnapshot.parse({
      schemaVersion: 1,
      collectorId: 'spire-1',
      takenAt: '2026-11-02T22:05:10.000Z',
      items: [
        { type: 'reader', key: '16', name: 'Lobby Door' },
        {
          type: 'portal',
          key: '4',
          name: 'Lobby',
          readers: [{ key: '16', name: 'Lobby Door', order: 1 }],
        },
      ],
    });
    expect(snap.items).toHaveLength(2);
  });
});
