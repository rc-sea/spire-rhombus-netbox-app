import { BridgeEvent } from '@spire/shared';
import { describe, expect, it } from 'vitest';
import { fromAccessRecord, fromStreamEvent } from '../src/normalize.js';

const ctx = { collectorId: 'spire-1', siteTimezone: 'America/Los_Angeles' };
const receivedAt = new Date('2026-11-02T22:05:10.000Z');

describe('fromStreamEvent', () => {
  it('maps Access Granted with tzoffset CDT to a content-derived id', () => {
    const e = fromStreamEvent(
      {
        tags: {
          ACTIVITYID: '976',
          DESCNAME: 'Access Granted',
          CDT: '2026-11-02 14:05:09 -0800',
          RDRNAME: 'Lobby Door',
          PERSONID: '90_JP',
          PERSONNAME: 'J. Smith',
        },
        receivedAt,
      },
      ctx,
    );
    expect(BridgeEvent.parse(e)).toEqual(e);
    expect(e.kind).toBe('access-granted');
    expect(e.occurredAt).toBe('2026-11-02T22:05:09.000Z');
    expect(e.id).toBe('spire-1:acc:access-granted:lobby door:90_jp:2026-11-02T22:05:09');
    expect(e.netbox).toMatchObject({
      activityId: '976',
      readerName: 'Lobby Door',
      personName: 'J. Smith',
    });
  });

  it('uses the site timezone when CDT has no offset', () => {
    const e = fromStreamEvent(
      {
        tags: {
          ACTIVITYID: '1',
          DESCNAME: 'Access Granted',
          CDT: '2026-11-02 14:05:09',
          RDRNAME: 'X',
        },
        receivedAt,
      },
      ctx,
    );
    expect(e.occurredAt).toBe('2026-11-02T22:05:09.000Z');
  });

  it('maps Invalid Access with detail and the other documented kinds', () => {
    const cases: [string, string][] = [
      ['Invalid Access', 'access-denied'],
      ['Portal Forced Open', 'door-forced'],
      ['Portal Held Open', 'door-held'],
      ['Portal Restored', 'door-restored'],
      ['Momentary Unlock', 'door-unlock'],
      ['Elevator Access Granted', 'elevator-granted'],
      ['Elevator Access Denied', 'elevator-denied'],
      ['Elevator Free Access', 'elevator-free-access'],
      ['Event Activated', 'event-activated'],
      ['Event Normal', 'event-normal'],
      ['Network Node Timeout', 'netbox-health'],
      ['Something New', 'other'],
    ];
    for (const [desc, kind] of cases) {
      const e = fromStreamEvent(
        {
          tags: {
            ACTIVITYID: '5',
            DESCNAME: desc,
            DETAIL: 'Card expired',
            CDT: '2026-11-02 14:05:09 -0800',
          },
          receivedAt,
        },
        ctx,
      );
      expect(e.kind, desc).toBe(kind);
      expect(e.netbox.detail).toBe('Card expired');
    }
  });

  it('keys non-access events by ACTIVITYID', () => {
    const e = fromStreamEvent(
      {
        tags: {
          ACTIVITYID: '977',
          DESCNAME: 'Portal Forced Open',
          CDT: '2026-11-02 14:05:30 -0800',
          PORTALNAME: 'Lobby',
        },
        receivedAt,
      },
      ctx,
    );
    expect(e.id).toBe('spire-1:act:977');
  });

  it('falls back to receive time when CDT is missing or unparseable', () => {
    const e = fromStreamEvent(
      { tags: { ACTIVITYID: '2', DESCNAME: 'Event Activated', CDT: 'garbage' }, receivedAt },
      ctx,
    );
    expect(e.occurredAt).toBe(receivedAt.toISOString());
  });
});

describe('fromAccessRecord', () => {
  it('produces the same id as the stream for the same fob read', () => {
    const fromHistory = fromAccessRecord(
      {
        logId: '56951',
        personId: '90_JP',
        reader: 'Lobby Door',
        dttm: '2026-11-02 14:05:09 -0800',
        readerKey: '16',
        portalKey: '4',
        type: '1',
      },
      ctx,
      receivedAt,
    );
    const fromStream = fromStreamEvent(
      {
        tags: {
          ACTIVITYID: '976',
          DESCNAME: 'Access Granted',
          CDT: '2026-11-02 14:05:09 -0800',
          RDRNAME: 'Lobby Door',
          PERSONID: '90_JP',
        },
        receivedAt,
      },
      ctx,
    );
    expect(fromHistory.id).toBe(fromStream.id);
    expect(fromHistory.source).toBe('history');
    expect(fromHistory.netbox).toMatchObject({
      logId: '56951',
      readerKey: '16',
      portalKey: '4',
      accessType: '1',
    });
  });

  it('maps non-1 TYPE to access-denied with the reason', () => {
    const e = fromAccessRecord(
      {
        logId: '7',
        personId: 'x',
        reader: 'Lobby Door',
        dttm: '2026-11-02 14:05:09 -0800',
        type: '2',
        reason: '5',
      },
      ctx,
      receivedAt,
    );
    expect(e.kind).toBe('access-denied');
    expect(e.netbox.reason).toBe('5');
  });
});
