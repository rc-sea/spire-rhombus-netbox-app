/**
 * End-to-end: a Collector against a fake NetBox and a fake cloud.
 */
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudClient } from '../src/cloud.js';
import { Collector } from '../src/collector.js';
import type { CollectorConfig } from '../src/config.js';
import { NbapiClient } from '../src/nbapi/client.js';
import { reconcile } from '../src/reconcile.js';
import { KV_LAST_LOG_ID, Spool } from '../src/spool.js';
import { FakeCloud } from './fake-cloud.js';
import { FakeNetBox } from './fake-netbox.js';

const log = pino({ level: 'silent' });
let netbox: FakeNetBox | undefined;
let cloud: FakeCloud | undefined;
let collector: Collector | undefined;

afterEach(async () => {
  await collector?.stop();
  await netbox?.stop();
  await cloud?.stop();
  collector = netbox = cloud = undefined;
});

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function config(
  netboxUrl: string,
  cloudUrl: string,
  over: Partial<CollectorConfig['intervals']> = {},
): CollectorConfig {
  return {
    collectorId: 'spire-1',
    collectorVersion: 'test',
    netbox: {
      baseUrl: netboxUrl,
      username: 'api',
      password: 'secret',
      version: 'auto',
      pathFamily: 'auto',
      bodyMode: 'raw',
      sessionCookie: true,
      tlsInsecure: false,
      caFile: undefined,
      paths: {},
    },
    siteTimezone: 'America/Los_Angeles',
    cloud: { baseUrl: cloudUrl, secret: 'cloud-secret' },
    spool: { path: ':memory:', maxEvents: 1000, maxAgeDays: 7 },
    intervals: {
      reconcileMs: 200,
      heartbeatMs: 150,
      inventoryMs: 60_000,
      streamSilenceMs: 2000,
      ...over,
    },
    deliveryBatchSize: 100,
    healthPort: 0,
    logLevel: 'silent',
  };
}

async function boot(nbws = false): Promise<void> {
  netbox = new FakeNetBox({ keepAliveMs: 50, apiVersion: nbws ? '6.2' : '4.7', nbws });
  cloud = new FakeCloud();
  const [nUrl, cUrl] = await Promise.all([netbox.start(), cloud.start()]);
  netbox.accesses = [
    {
      logId: 100,
      personId: '90_JP',
      reader: 'Lobby Door',
      dttm: '2026-11-02 14:00:00 -0800',
      readerKey: '16',
      portalKey: '4',
    },
  ];
  collector = new Collector(config(nUrl, cUrl), log);
  await collector.start();
}

describe('Collector end to end', () => {
  it('probes, streams, spools, delivers and heartbeats', async () => {
    await boot();
    expect(collector?.netboxStatus).toBe('connected');
    expect(collector?.apiVersionReported).toBe('4.7');
    await waitFor(() => (netbox?.openStreamCount ?? 0) === 1);
    netbox?.emit({
      ACTIVITYID: '976',
      DESCNAME: 'Access Granted',
      CDT: '2026-11-02 14:05:09 -0800',
      RDRNAME: 'Lobby Door',
      PERSONID: '90_JP',
    });
    netbox?.emit({
      ACTIVITYID: '977',
      DESCNAME: 'Portal Forced Open',
      CDT: '2026-11-02 14:05:30 -0800',
      PORTALNAME: 'Lobby',
    });
    await waitFor(() => (cloud?.received.size ?? 0) === 2);
    const forced = [...(cloud?.received.values() ?? [])].find((e) => e.kind === 'door-forced');
    expect(forced?.occurredAt).toBe('2026-11-02T22:05:30.000Z');
    await waitFor(() => (cloud?.heartbeats.length ?? 0) >= 1);
    const hb = cloud?.heartbeats.at(-1);
    expect(hb?.netboxStatus).toBe('connected');
    expect(hb?.nbapiVersionReported).toBe('4.7 (legacy)');
    expect(hb?.cloudStatus).toBe('ok');
    await waitFor(() => (cloud?.inventories.length ?? 0) >= 1);
    const inv = cloud?.inventories[0];
    expect(inv?.items.some((i) => i.type === 'reader' && i.name === 'Lobby Door')).toBe(true);
    expect(inv?.items.some((i) => i.type === 'portal' && i.readers?.length === 1)).toBe(true);
    expect(inv?.items.some((i) => i.type === 'event')).toBe(true);
  });

  it('works unchanged against a 6.x-style NetBox under /nbws', async () => {
    await boot(true);
    expect(collector?.netbox.pathFamily).toBe('nbws');
    await waitFor(() => (netbox?.openStreamCount ?? 0) === 1);
    netbox?.emit({
      ACTIVITYID: '1',
      DESCNAME: 'Access Granted',
      CDT: '2026-11-02 14:05:09 -0800',
      RDRNAME: 'Lobby Door',
    });
    await waitFor(() => (cloud?.received.size ?? 0) === 1);
    await waitFor(() => (cloud?.heartbeats.length ?? 0) >= 1);
    expect(cloud?.heartbeats.at(-1)?.nbapiVersionReported).toBe('6.2 (nbws)');
  });

  it('recovers a gap via access history after the stream drops, without duplicating', async () => {
    await boot();
    await waitFor(() => (netbox?.openStreamCount ?? 0) === 1);
    // High-water mark established at logId 100 on first reconcile.
    await waitFor(() => collector?.spool.get(KV_LAST_LOG_ID) === '100');
    // Stream delivers one read; the same read also lands in access history (same reader/person/second).
    netbox?.emit({
      ACTIVITYID: '200',
      DESCNAME: 'Access Granted',
      CDT: '2026-11-02 14:10:00 -0800',
      RDRNAME: 'Lobby Door',
      PERSONID: '90_JP',
    });
    netbox?.accesses.push(
      {
        logId: 101,
        personId: '90_JP',
        reader: 'Lobby Door',
        dttm: '2026-11-02 14:10:00 -0800',
        readerKey: '16',
        portalKey: '4',
      },
      {
        logId: 102,
        personId: '37_KD',
        reader: 'Stair 1 3rd Floor Emp. Entrance',
        dttm: '2026-11-02 14:11:00 -0800',
        readerKey: '19',
        portalKey: '5',
      },
    );
    netbox?.dropStreams(); // outage: reconnect triggers reconcile
    await waitFor(() => collector?.spool.get(KV_LAST_LOG_ID) === '102');
    await waitFor(() => (cloud?.received.size ?? 0) >= 2);
    await new Promise((r) => setTimeout(r, 300));
    const ids = [...(cloud?.received.keys() ?? [])];
    // The fob read seen on both paths has one id; the history-only one is marked history.
    expect(ids).toHaveLength(2);
    expect(ids.filter((i) => i.includes('lobby door')).length).toBe(1);
    const stairs = [...(cloud?.received.values() ?? [])].find((e) =>
      e.netbox.readerName?.startsWith('Stair'),
    );
    expect(stairs?.source).toBe('history');
  });

  it('reports auth-failed in the heartbeat when NetBox rejects the credentials', async () => {
    netbox = new FakeNetBox({ keepAliveMs: 50 });
    cloud = new FakeCloud();
    const [nUrl, cUrl] = await Promise.all([netbox.start(), cloud.start()]);
    const cfg = config(nUrl, cUrl);
    cfg.netbox.password = 'wrong';
    collector = new Collector(cfg, log);
    await collector.start();
    expect(collector.netboxStatus).toBe('auth-failed');
    await waitFor(() => (cloud?.heartbeats.length ?? 0) >= 1);
    expect(cloud?.heartbeats[0]?.netboxStatus).toBe('auth-failed');
  });

  it('refresh-inventory action from a heartbeat triggers a new inventory', async () => {
    await boot();
    await waitFor(() => (cloud?.inventories.length ?? 0) >= 1);
    netbox?.readers.push({ key: '30', name: 'New Reader' });
    cloud?.pendingActions.push('refresh-inventory');
    await waitFor(() => (cloud?.inventories.length ?? 0) >= 2, 8000);
    expect(cloud?.inventories.at(-1)?.items.some((i) => i.name === 'New Reader')).toBe(true);
  });
});

describe('reconcile', () => {
  it('initialises the high-water mark without replaying history', async () => {
    netbox = new FakeNetBox();
    const url = await netbox.start();
    netbox.accesses = [
      {
        logId: 1,
        personId: 'a',
        reader: 'R',
        dttm: '2026-11-02 14:00:00 -0800',
        readerKey: '1',
        portalKey: '1',
      },
      {
        logId: 2,
        personId: 'b',
        reader: 'R',
        dttm: '2026-11-02 14:01:00 -0800',
        readerKey: '1',
        portalKey: '1',
      },
    ];
    const client = new NbapiClient({
      baseUrl: url,
      username: 'api',
      password: 'secret',
      version: 1,
    });
    const spool = new Spool({ path: ':memory:' });
    const r1 = await reconcile(client, spool, { collectorId: 'c', siteTimezone: 'UTC' }, log);
    expect(r1.newRecords).toBe(0);
    expect(spool.get(KV_LAST_LOG_ID)).toBe('2');
    netbox.accesses.push({
      logId: 3,
      personId: 'c',
      reader: 'R',
      dttm: '2026-11-02 14:02:00 -0800',
      readerKey: '1',
      portalKey: '1',
    });
    const r2 = await reconcile(client, spool, { collectorId: 'c', siteTimezone: 'UTC' }, log, {
      pageSize: 1,
      pageDelayMs: 1,
    });
    expect(r2.newRecords).toBe(1);
    expect(spool.size()).toBe(1);
    expect(spool.get(KV_LAST_LOG_ID)).toBe('3');
    spool.close();
    await client.logout();
    const unusedCloud = new CloudClient({ baseUrl: 'http://127.0.0.1:1', secret: 'x' });
    expect(unusedCloud).toBeDefined();
  });
});
