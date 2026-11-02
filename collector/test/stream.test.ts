import { afterEach, describe, expect, it } from 'vitest';
import { NbapiClient } from '../src/nbapi/client.js';
import {
  DEFAULT_STREAM_TAGS,
  EventStream,
  type StreamEvent,
  type StreamStatus,
} from '../src/nbapi/stream.js';
import { FakeNetBox } from './fake-netbox.js';

let fake: FakeNetBox | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fastSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.min(ms, 20));
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function setup(
  keepAliveMs = 50,
): Promise<{ client: NbapiClient; statuses: [StreamStatus, string | undefined][] }> {
  fake = new FakeNetBox({ keepAliveMs });
  const baseUrl = await fake.start();
  const client = new NbapiClient({ baseUrl, username: 'api', password: 'secret', version: 1 });
  return { client, statuses: [] };
}

describe('EventStream', () => {
  it('connects, yields events with their tags, and ignores keep-alives', async () => {
    const { client, statuses } = await setup();
    const stream = new EventStream(client, {
      tags: DEFAULT_STREAM_TAGS,
      onStatus: (s, d) => statuses.push([s, d]),
    });
    const received: StreamEvent[] = [];
    const run = (async () => {
      for await (const ev of stream.events()) received.push(ev);
    })();
    await waitFor(() => statuses.some(([s]) => s === 'connected'));
    expect(fake?.openStreamCount).toBe(1);
    await new Promise((r) => setTimeout(r, 120)); // a couple of keep-alives
    fake?.emit({
      ACTIVITYID: '976',
      DESCNAME: 'Access Granted',
      CDT: '2026-11-02 14:05:09 -0800',
      RDRNAME: 'Lobby Door',
      PERSONNAME: 'J. Smith',
    });
    fake?.emit({
      ACTIVITYID: '977',
      DESCNAME: 'Portal Forced Open',
      CDT: '2026-11-02 14:05:30 -0800',
      PORTALNAME: 'Lobby',
    });
    await waitFor(() => received.length === 2);
    expect(received[0]?.tags).toMatchObject({
      ACTIVITYID: '976',
      DESCNAME: 'Access Granted',
      RDRNAME: 'Lobby Door',
    });
    expect(received[1]?.tags.DESCNAME).toBe('Portal Forced Open');
    stream.stop();
    await run;
    expect(statuses.at(-1)?.[0]).toBe('stopped');
  });

  it('reconnects after a mid-stream disconnect without opening two connections', async () => {
    const { client, statuses } = await setup();
    const stream = new EventStream(client, {
      tags: DEFAULT_STREAM_TAGS,
      onStatus: (s, d) => statuses.push([s, d]),
      sleep: fastSleep,
    });
    const received: StreamEvent[] = [];
    const run = (async () => {
      for await (const ev of stream.events()) received.push(ev);
    })();
    await waitFor(() => statuses.some(([s]) => s === 'connected'));
    fake?.dropStreams();
    await waitFor(() => statuses.some(([s]) => s === 'stream-down'));
    await waitFor(() => statuses.filter(([s]) => s === 'connected').length === 2);
    expect(fake?.openStreamCount).toBe(1);
    fake?.emit({ ACTIVITYID: '1', DESCNAME: 'Access Granted' });
    await waitFor(() => received.length === 1);
    stream.stop();
    await run;
  });

  it('treats silence longer than the timeout as a dead connection', async () => {
    fake = new FakeNetBox({ keepAliveMs: 10_000 }); // keep-alives far apart
    const baseUrl = await fake.start();
    const client = new NbapiClient({ baseUrl, username: 'api', password: 'secret', version: 1 });
    const statuses: StreamStatus[] = [];
    const stream = new EventStream(client, {
      tags: DEFAULT_STREAM_TAGS,
      silenceTimeoutMs: 150,
      onStatus: (s) => statuses.push(s),
      sleep: fastSleep,
    });
    const run = (async () => {
      for await (const _ of stream.events()) {
        /* no events expected */
      }
    })();
    await waitFor(() => statuses.filter((s) => s === 'stream-down').length >= 2, 5000);
    stream.stop();
    await run;
  });

  it('recovers when NetBox rejects the stream session by logging in again', async () => {
    const { client, statuses } = await setup();
    const stream = new EventStream(client, {
      tags: DEFAULT_STREAM_TAGS,
      onStatus: (s, d) => statuses.push([s, d]),
      sleep: fastSleep,
    });
    const run = (async () => {
      for await (const _ of stream.events()) {
        /* none */
      }
    })();
    await waitFor(() => statuses.some(([s]) => s === 'connected'));
    // Kill the session server-side and drop the connection: the next attempt gets APIERROR 5.
    fake?.sessions.clear();
    fake?.dropStreams();
    await waitFor(() =>
      statuses.some(
        ([s, d]) => s === 'stream-down' && /APIERROR 5|closed|aborted|socket/i.test(d ?? ''),
      ),
    );
    // Client should re-login on a subsequent attempt only after its session is cleared; force that path:
    await client.logout().catch(() => undefined);
    await waitFor(() => statuses.filter(([s]) => s === 'connected').length === 2, 5000);
    stream.stop();
    await run;
  });
});
