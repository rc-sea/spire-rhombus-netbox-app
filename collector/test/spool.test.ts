import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BridgeEvent, SCHEMA_VERSION } from '@spire/shared';
import { describe, expect, it } from 'vitest';
import { KV_LAST_LOG_ID, Spool } from '../src/spool.js';

function ev(id: string): BridgeEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    collectorId: 'spire-1',
    source: 'stream',
    kind: 'access-granted',
    occurredAt: '2026-11-02T22:05:09.000Z',
    receivedAt: '2026-11-02T22:05:10.000Z',
    netbox: { activityId: id },
  };
}

describe('Spool', () => {
  it('enqueues, peeks oldest-first, acks, and ignores duplicate ids', () => {
    const s = new Spool({ path: ':memory:' });
    expect(s.enqueue([ev('a'), ev('b')])).toBe(2);
    expect(s.enqueue([ev('b'), ev('c')])).toBe(1);
    expect(s.size()).toBe(3);
    expect(s.peek(2).map((e) => e.id)).toEqual(['a', 'b']);
    s.ack(['a', 'b']);
    expect(s.peek(10).map((e) => e.id)).toEqual(['c']);
    s.close();
  });

  it('survives a process restart (same file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-'));
    const path = join(dir, 'spool.sqlite');
    const s1 = new Spool({ path });
    s1.enqueue([ev('x'), ev('y')]);
    s1.set(KV_LAST_LOG_ID, '56957');
    s1.close();
    const s2 = new Spool({ path });
    expect(s2.peek(10).map((e) => e.id)).toEqual(['x', 'y']);
    expect(s2.get(KV_LAST_LOG_ID)).toBe('56957');
    s2.close();
  });

  it('drops the oldest beyond the count bound', () => {
    const s = new Spool({ path: ':memory:', maxEvents: 3 });
    s.enqueue([ev('1'), ev('2'), ev('3'), ev('4'), ev('5')]);
    expect(s.size()).toBe(3);
    expect(s.peek(10).map((e) => e.id)).toEqual(['3', '4', '5']);
    s.close();
  });

  it('drops events older than the age bound', () => {
    const s = new Spool({ path: ':memory:', maxAgeDays: 0 }); // everything is immediately too old
    s.enqueue([ev('old')]);
    expect(s.size()).toBe(0);
    s.close();
  });

  it('kv upserts', () => {
    const s = new Spool({ path: ':memory:' });
    expect(s.get('k')).toBeUndefined();
    s.set('k', '1');
    s.set('k', '2');
    expect(s.get('k')).toBe('2');
    s.close();
  });
});
