import { type BridgeEvent, SCHEMA_VERSION } from '@spire/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateCollector, generateSecret, hashSecret } from '@/lib/collector-auth';
import type { Mapping } from '@/lib/db/repo';
import { ingestEvents } from '@/lib/ingest';
import { resolveTargets } from '@/lib/mapping';
import { backoffMs, publishDue } from '@/lib/publisher';
import { RhombusClient } from '@/lib/rhombus';
import { clip, toSeekpoint } from '@/lib/seekpoint';
import { MemoryRepo } from './memory-repo';

const COLLECTOR = 'spire-1';

function ev(
  id: string,
  over: Partial<BridgeEvent> = {},
  netbox: BridgeEvent['netbox'] = {},
): BridgeEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    collectorId: COLLECTOR,
    source: 'stream',
    kind: 'access-granted',
    occurredAt: '2026-11-02T22:05:09.000Z',
    receivedAt: '2026-11-02T22:05:10.000Z',
    netbox: { readerName: 'Lobby Door', readerKey: '16', personName: 'J. Smith', ...netbox },
    ...over,
  };
}

function mapping(over: Partial<Mapping>): Mapping {
  return {
    id: Math.floor(Math.random() * 1e6),
    sourceType: 'reader',
    sourceKey: '16',
    sourceNameSnapshot: 'Lobby Door',
    cameraUuid: 'CAM-A',
    enabled: true,
    overlay: null,
    colorOverride: null,
    ...over,
  };
}

/** A fake Rhombus: records calls, can fail per camera. */
function fakeRhombus(
  opts: { fail?: Record<string, { status: number; code?: string; times?: number }> } = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const remaining = new Map(
    Object.entries(opts.fail ?? {}).map(([k, v]) => [k, v.times ?? Number.POSITIVE_INFINITY]),
  );
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const cam = body.cameraUuid as string | undefined;
    const f = cam ? opts.fail?.[cam] : undefined;
    if (f && (remaining.get(cam as string) ?? 0) > 0) {
      remaining.set(cam as string, (remaining.get(cam as string) ?? 0) - 1);
      return new Response(JSON.stringify({ error: true, errorCode: f.code ?? 'INTERNAL_ERROR' }), {
        status: f.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.endsWith('getMinimalCameraStateList')) {
      return new Response(JSON.stringify({ cameraStates: [{ uuid: 'CAM-A', name: 'P1 Ramp' }] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: new RhombusClient({ apiKey: 'k', fetch: fetchImpl }), calls };
}

let repo: MemoryRepo;
beforeEach(() => {
  repo = new MemoryRepo();
  repo.collectors.set(COLLECTOR, {
    id: COLLECTOR,
    name: 'Spire',
    secretHash: hashSecret('s3cret'),
    lastSeenAt: null,
    lastHeartbeat: null,
  });
});

describe('collector auth', () => {
  it('accepts <id>.<secret> and rejects everything else', async () => {
    expect(await authenticateCollector(repo, `Bearer ${COLLECTOR}.s3cret`)).toEqual({
      id: COLLECTOR,
    });
    expect(await authenticateCollector(repo, `Bearer ${COLLECTOR}.wrong`)).toBeNull();
    expect(await authenticateCollector(repo, 'Bearer nope.s3cret')).toBeNull();
    expect(await authenticateCollector(repo, 'Bearer s3cret')).toBeNull();
    expect(await authenticateCollector(repo, null)).toBeNull();
  });
  it('generates distinct url-safe secrets', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe('ingestEvents', () => {
  it('stores new events, acknowledges duplicates without new jobs, rejects foreign collector ids', async () => {
    repo.mappings.push(mapping({}));
    const batch = {
      schemaVersion: 1,
      events: [ev('a'), ev('b'), ev('c', { collectorId: 'other' })],
    };
    const first = await ingestEvents(repo, COLLECTOR, batch);
    expect(first.response.accepted.sort()).toEqual(['a', 'b']);
    expect(first.response.rejected).toEqual([
      { id: 'c', error: 'collectorId does not match credentials' },
    ]);
    expect(first.inserted.sort()).toEqual(['a', 'b']);
    expect(repo.jobs).toHaveLength(2);
    const again = await ingestEvents(repo, COLLECTOR, { schemaVersion: 1, events: [ev('a')] });
    expect(again.response.accepted).toEqual(['a']);
    expect(again.inserted).toEqual([]);
    expect(repo.jobs).toHaveLength(2);
  });

  it('rejects an invalid event individually and keeps the rest', async () => {
    const out = await ingestEvents(repo, COLLECTOR, {
      schemaVersion: 1,
      events: [ev('ok'), { id: 'bad', nope: true }],
    });
    expect(out.response.accepted).toEqual(['ok']);
    expect(out.response.rejected[0]?.id).toBe('bad');
  });

  it('marks unmapped, ignored and health events without jobs', async () => {
    const out = await ingestEvents(repo, COLLECTOR, {
      schemaVersion: 1,
      events: [ev('u'), ev('h', { kind: 'netbox-health' }), ev('n', { kind: 'event-normal' })],
    });
    expect(out.response.accepted).toHaveLength(3);
    expect(repo.events.get('u')?.status).toBe('unmapped');
    expect(repo.events.get('h')?.status).toBe('ignored');
    expect(repo.events.get('n')?.status).toBe('ignored'); // event-normal not in publishKinds
    expect(repo.jobs).toHaveLength(0);
  });

  it('fans out to two cameras and uses the catch-all when configured', async () => {
    repo.mappings.push(mapping({ cameraUuid: 'CAM-A' }), mapping({ cameraUuid: 'CAM-B' }));
    repo.settings.unmappedPolicy = 'catch-all';
    repo.settings.catchAllCamera = 'CAM-X';
    await ingestEvents(repo, COLLECTOR, {
      schemaVersion: 1,
      events: [ev('two'), ev('other', {}, { readerName: 'Unknown', readerKey: '99' })],
    });
    expect(repo.events.get('two')?.targetCameras.sort()).toEqual(['CAM-A', 'CAM-B']);
    expect(repo.events.get('other')?.targetCameras).toEqual(['CAM-X']);
    expect(repo.jobs).toHaveLength(3);
  });
});

describe('resolveTargets precedence', () => {
  it('reader beats portal beats event name; disabled mappings are skipped; keys and names both match', () => {
    const ms = [
      mapping({
        sourceType: 'event',
        sourceKey: 'Motion',
        sourceNameSnapshot: 'Motion',
        cameraUuid: 'CAM-E',
      }),
      mapping({
        sourceType: 'portal',
        sourceKey: '4',
        sourceNameSnapshot: 'Lobby',
        cameraUuid: 'CAM-P',
      }),
      mapping({
        sourceType: 'reader',
        sourceKey: '16',
        sourceNameSnapshot: 'Lobby Door',
        cameraUuid: 'CAM-R',
        enabled: false,
      }),
    ];
    const e = ev(
      'x',
      {},
      { readerName: 'Lobby Door', readerKey: '16', portalName: 'Lobby', eventName: 'Motion' },
    );
    expect(resolveTargets(e, ms, repo.settings)).toMatchObject({
      cameras: ['CAM-P'],
      matchedBy: 'portal',
    });
    ms[2] = mapping({
      sourceType: 'reader',
      sourceKey: '16',
      sourceNameSnapshot: 'Lobby Door',
      cameraUuid: 'CAM-R',
    });
    expect(resolveTargets(e, ms, repo.settings)).toMatchObject({
      cameras: ['CAM-R'],
      matchedBy: 'reader',
    });
    // Name-only match (stream events carry no reader key).
    const byName = ev('y', {}, { readerName: 'lobby door' });
    expect(resolveTargets(byName, ms, repo.settings).cameras).toEqual(['CAM-R']);
  });

  it('applies overlay defaults and overrides', () => {
    const e = ev('f', { kind: 'door-forced' }, { portalName: 'Lobby' });
    const ms = [
      mapping({
        sourceType: 'portal',
        sourceKey: '4',
        sourceNameSnapshot: 'Lobby',
        cameraUuid: 'CAM-P',
      }),
    ];
    expect(resolveTargets(e, ms, repo.settings).overlay).toBe(true); // door-forced in overlayKinds
    ms[0] = mapping({
      sourceType: 'portal',
      sourceKey: '4',
      sourceNameSnapshot: 'Lobby',
      cameraUuid: 'CAM-P',
      overlay: false,
    });
    expect(resolveTargets(e, ms, repo.settings).overlay).toBe(false);
    ms[0] = mapping({
      sourceType: 'portal',
      sourceKey: '4',
      sourceNameSnapshot: 'Lobby',
      cameraUuid: 'CAM-P',
      colorOverride: 'BLACK',
    });
    expect(resolveTargets(e, ms, repo.settings).colorOverride).toBe('BLACK');
  });
});

describe('toSeekpoint', () => {
  it('formats name, description, colour and timestamp within limits', () => {
    const p = toSeekpoint(
      ev(
        'a',
        {},
        {
          readerName: 'P1 Garage Entry Reader',
          personName: 'Jane Q. Resident',
          descName: 'Access Granted',
        },
      ),
      { overlay: false },
    );
    expect(p.name).toBe('Access · P1 Garage Entry');
    expect(p.name.length).toBeLessThanOrEqual(32);
    expect(p.description).toBe('Jane Q. Resident — Access Granted');
    expect(p.color).toBe('BLUE');
    expect(p.timestampMs).toBe(Date.parse('2026-11-02T22:05:09.000Z'));
    expect(p.displayOverlay).toBe(false);
  });

  it('truncates long names and descriptions and uses kind colours', () => {
    const long = 'A'.repeat(80);
    const p = toSeekpoint(
      ev('b', { kind: 'door-forced' }, { readerName: long, personName: long, detail: long }),
      { overlay: true },
    );
    expect(p.name.length).toBe(32);
    expect(p.description.length).toBe(100);
    expect(p.color).toBe('RED');
    expect(clip('abc', 2)).toBe('a…');
  });
});

describe('publishDue', () => {
  it('groups jobs per camera into one call each and marks published', async () => {
    repo.mappings.push(mapping({ cameraUuid: 'CAM-A' }), mapping({ cameraUuid: 'CAM-B' }));
    await ingestEvents(repo, COLLECTOR, {
      schemaVersion: 1,
      events: [ev('1'), ev('2', { occurredAt: '2026-11-02T22:06:00.000Z' })],
    });
    const { client, calls } = fakeRhombus();
    const s = await publishDue(repo, client);
    expect(s).toMatchObject({ considered: 4, published: 4, retried: 0, failed: 0, cameras: 2 });
    expect(calls.filter((c) => c.path.endsWith('createCustomFootageSeekpoints'))).toHaveLength(2);
    const camA = calls.find((c) => c.body.cameraUuid === 'CAM-A');
    const points = camA?.body.footageSeekPoints as unknown[] | undefined;
    expect(points?.length).toBe(2);
    expect(repo.events.get('1')?.status).toBe('published');
    expect(await repo.countPendingJobs()).toBe(0);
  });

  it('backs off on 429 and keeps the jobs pending', async () => {
    repo.mappings.push(mapping({ cameraUuid: 'CAM-A' }));
    await ingestEvents(repo, COLLECTOR, { schemaVersion: 1, events: [ev('r')] });
    const { client } = fakeRhombus({
      fail: { 'CAM-A': { status: 429, code: 'RATE_LIMITED', times: 1 } },
    });
    const t0 = new Date('2026-11-02T23:00:00.000Z');
    const s1 = await publishDue(repo, client, { now: () => t0 });
    expect(s1).toMatchObject({ retried: 1, published: 0 });
    const job = repo.jobs[0];
    expect(job?.status).toBe('pending');
    expect(job?.lastErrorCode).toBe('RATE_LIMITED');
    expect(Date.parse(job?.nextAttemptAt ?? '') - t0.getTime()).toBe(backoffMs(1));
    // Not due yet
    expect((await publishDue(repo, client, { now: () => t0 })).considered).toBe(0);
    // Due later: succeeds
    const t1 = new Date(t0.getTime() + backoffMs(1) + 1);
    const s2 = await publishDue(repo, client, { now: () => t1 });
    expect(s2.published).toBe(1);
    expect(repo.events.get('r')?.status).toBe('published');
  });

  it('on a validation error retries individually, fails the bad one, and marks the event partial', async () => {
    repo.mappings.push(mapping({ cameraUuid: 'CAM-A' }), mapping({ cameraUuid: 'CAM-B' }));
    await ingestEvents(repo, COLLECTOR, { schemaVersion: 1, events: [ev('v')] });
    const { client } = fakeRhombus({
      fail: { 'CAM-B': { status: 400, code: 'VALIDATION_FAILED' } },
    });
    const s = await publishDue(repo, client);
    expect(s).toMatchObject({ published: 1, failed: 1 });
    expect(repo.events.get('v')?.status).toBe('partial');
    const failed = repo.jobs.find((j) => j.cameraUuid === 'CAM-B');
    expect(failed?.status).toBe('failed');
    expect(failed?.lastErrorCode).toBe('VALIDATION_FAILED');
  });

  it('gives up after maxAttempts on persistent 5xx', async () => {
    repo.mappings.push(mapping({ cameraUuid: 'CAM-A' }));
    await ingestEvents(repo, COLLECTOR, { schemaVersion: 1, events: [ev('g')] });
    const { client } = fakeRhombus({ fail: { 'CAM-A': { status: 503 } } });
    let t = new Date('2026-11-02T23:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      await publishDue(repo, client, { now: () => t, maxAttempts: 3 });
      t = new Date(t.getTime() + 2 * 3_600_000);
    }
    expect(repo.jobs[0]?.status).toBe('failed');
    expect(repo.events.get('g')?.status).toBe('failed');
  });

  it('backoff doubles and caps at an hour', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });
});

describe('RhombusClient', () => {
  it('lists cameras and surfaces Rhombus error envelopes', async () => {
    const { client } = fakeRhombus();
    expect(await client.listCameras()).toEqual([{ uuid: 'CAM-A', name: 'P1 Ramp' }]);
    const bad = new RhombusClient({
      apiKey: 'k',
      fetch: async () =>
        new Response(JSON.stringify({ error: true, errorCode: 'ROLE_NOT_PERMITTED' }), {
          status: 403,
        }),
    });
    await expect(bad.listCameras()).rejects.toMatchObject({
      errorCode: 'ROLE_NOT_PERMITTED',
      retryable: false,
    });
  });

  it('never puts the API key in error messages', async () => {
    const bad = new RhombusClient({
      apiKey: 'SUPERSECRET',
      fetch: async () => new Response('oops', { status: 500 }),
    });
    await expect(bad.listCameras()).rejects.not.toThrow(/SUPERSECRET/);
  });
});
