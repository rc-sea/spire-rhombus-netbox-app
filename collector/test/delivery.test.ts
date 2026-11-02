import { type BridgeEvent, SCHEMA_VERSION } from '@spire/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudClient } from '../src/cloud.js';
import { Delivery } from '../src/delivery.js';
import { Spool } from '../src/spool.js';
import { FakeCloud } from './fake-cloud.js';

const log = pino({ level: 'silent' });
let cloud: FakeCloud | undefined;
afterEach(async () => {
  await cloud?.stop();
  cloud = undefined;
});

function ev(id: string): BridgeEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    collectorId: 'spire-1',
    source: 'stream',
    kind: 'access-granted',
    occurredAt: '2026-11-02T22:05:09.000Z',
    receivedAt: '2026-11-02T22:05:10.000Z',
    netbox: {},
  };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const fastSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.min(ms, 15));
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

async function setup(secret = 'cloud-secret') {
  cloud = new FakeCloud();
  const url = await cloud.start();
  const spool = new Spool({ path: ':memory:' });
  const client = new CloudClient({ baseUrl: url, secret, timeoutMs: 2000 });
  const delivery = new Delivery(spool, client, log, { batchSize: 3, sleep: fastSleep, idleMs: 20 });
  return { spool, delivery };
}

describe('Delivery', () => {
  it('delivers in batches and acks the spool', async () => {
    const { spool, delivery } = await setup();
    spool.enqueue([ev('1'), ev('2'), ev('3'), ev('4'), ev('5')]);
    const run = delivery.run();
    await waitFor(() => spool.size() === 0);
    expect(cloud?.received.size).toBe(5);
    expect(cloud?.ingestCalls).toBe(2); // 3 + 2
    expect(delivery.status).toBe('ok');
    delivery.stop();
    await run;
  });

  it('retries through 5xx with backoff and keeps spooling', async () => {
    const { spool, delivery } = await setup();
    if (cloud) cloud.failNext = { status: 503, remaining: 3 };
    spool.enqueue([ev('a')]);
    const run = delivery.run();
    await waitFor(() => delivery.status === 'backlogged' || delivery.status === 'unreachable');
    spool.enqueue([ev('b')]);
    delivery.poke();
    await waitFor(() => spool.size() === 0);
    expect(cloud?.received.has('a')).toBe(true);
    expect(cloud?.received.has('b')).toBe(true);
    expect(cloud?.ingestCalls).toBeGreaterThanOrEqual(4);
    delivery.stop();
    await run;
  });

  it('holds on 401 without discarding, and resumes after poke', async () => {
    const { spool, delivery } = await setup('wrong');
    spool.enqueue([ev('a')]);
    const run = delivery.run();
    await waitFor(() => delivery.status === 'auth-failed');
    const callsAtHold = cloud?.ingestCalls ?? 0;
    await new Promise((r) => setTimeout(r, 100));
    expect(cloud?.ingestCalls).toBe(callsAtHold); // no retries while held
    expect(spool.size()).toBe(1);
    if (cloud) cloud.secret = 'wrong'; // operator fixes the secret on the cloud side
    delivery.poke();
    await waitFor(() => spool.size() === 0);
    delivery.stop();
    await run;
  });

  it('removes permanently rejected events from the spool and keeps going', async () => {
    const { spool, delivery } = await setup();
    cloud?.rejectIds.add('bad');
    spool.enqueue([ev('good'), ev('bad')]);
    const run = delivery.run();
    await waitFor(() => spool.size() === 0);
    expect(cloud?.received.has('good')).toBe(true);
    expect(cloud?.received.has('bad')).toBe(false);
    delivery.stop();
    await run;
  });
});
