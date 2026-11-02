import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NbapiClient } from '../src/nbapi/client.js';
import {
  getAccessHistory,
  getApiVersion,
  getElevators,
  getFloors,
  getPortals,
  getReaders,
  listEvents,
  pingApp,
} from '../src/nbapi/commands.js';
import { NbapiAuthError, NbapiDisallowedCommandError, NbapiError } from '../src/nbapi/types.js';
import { FakeNetBox, type FakeNetBoxOptions } from './fake-netbox.js';

let fake: FakeNetBox;
let baseUrl: string;

async function boot(opts: FakeNetBoxOptions = {}): Promise<NbapiClient> {
  fake = new FakeNetBox(opts);
  baseUrl = await fake.start();
  return new NbapiClient({
    baseUrl,
    username: 'api',
    password: 'secret',
    version: 1,
    timeoutMs: 3000,
  });
}

beforeEach(() => {
  fake = undefined as unknown as FakeNetBox;
});
afterEach(async () => {
  if (fake) await fake.stop();
});

describe('session handling', () => {
  it('logs in lazily on the first command and reuses the session', async () => {
    const c = await boot();
    expect(c.isLoggedIn).toBe(false);
    expect(await pingApp(c)).toBe(true);
    expect(c.isLoggedIn).toBe(true);
    await pingApp(c);
    expect(fake.requests.filter((r) => r.command === 'Login')).toHaveLength(1);
  });

  it('reports auth failure clearly on bad credentials', async () => {
    fake = new FakeNetBox();
    baseUrl = await fake.start();
    const c = new NbapiClient({ baseUrl, username: 'api', password: 'wrong', version: 1 });
    await expect(pingApp(c)).rejects.toBeInstanceOf(NbapiAuthError);
  });

  it('re-logs-in and retries once when the session expires', async () => {
    const c = await boot({ sessionCommandLimit: 2 });
    await pingApp(c); // 1
    await pingApp(c); // 2
    expect(await pingApp(c)).toBe(true); // 3 → APIERROR 5 → re-login → retry
    expect(fake.requests.filter((r) => r.command === 'Login')).toHaveLength(2);
  });

  it('surfaces API-disabled (APIERROR 2) as a plain NbapiError', async () => {
    const c = await boot({ apiDisabled: true });
    await expect(pingApp(c)).rejects.toThrow(/APIERROR 2/);
  });

  it('logs out and forgets the session', async () => {
    const c = await boot();
    await pingApp(c);
    await c.logout();
    expect(c.isLoggedIn).toBe(false);
    expect(fake.sessions.size).toBe(0);
  });
});

describe('read-only allow-list', () => {
  it('refuses write commands before any request is sent', async () => {
    const c = await boot();
    await pingApp(c);
    const before = fake.requests.length;
    for (const cmd of [
      'AddPerson',
      'ModifyPerson',
      'UnlockPortal',
      'MomentaryUnlockPortal',
      'TriggerEvent',
      'SetThreatLevel',
      'ActivateOutput',
      'RemoveCredential',
    ]) {
      await expect(c.call(cmd, { LASTNAME: 'x' })).rejects.toBeInstanceOf(
        NbapiDisallowedCommandError,
      );
    }
    expect(fake.requests.length).toBe(before);
  });
});

describe('commands', () => {
  it('GetAPIVersion', async () => {
    const c = await boot({ apiVersion: '4.7' });
    expect(await getApiVersion(c)).toBe('4.7');
  });

  it('GetReaders pages through STARTFROMKEY/NEXTKEY', async () => {
    const c = await boot({ readerPageSize: 2 });
    const readers = await getReaders(c);
    expect(readers.map((r) => r.key)).toEqual(['16', '19', '21']);
    expect(readers[2]?.description).toBe('Garage ramp');
    expect(fake.requests.filter((r) => r.command === 'GetReaders')).toHaveLength(2);
  });

  it('GetPortals returns readers with portal order', async () => {
    const c = await boot();
    const portals = await getPortals(c);
    expect(portals).toHaveLength(2);
    expect(portals[0]).toEqual({
      key: '4',
      name: 'Lobby',
      readers: [{ key: '16', name: 'Lobby Door', order: 1 }],
    });
  });

  it('GetElevators, GetFloors and ListEvents', async () => {
    const c = await boot();
    expect((await getElevators(c)).map((e) => e.name)).toEqual(['Compass Bank A']);
    expect((await getFloors(c)).map((f) => f.key)).toEqual(['14']);
    expect(await listEvents(c)).toEqual(['158_backDoorForcedEvent', 'Motion detected at the Cafe']);
    expect(fake.requests.find((r) => r.command === 'ListEvents')?.path).toBe('/appd/nbapi');
  });

  it('GetAccessHistory supports descending default, AFTERLOGID catch-up and NOT FOUND', async () => {
    const c = await boot();
    fake.accesses = [
      {
        logId: 56948,
        personId: '76_RN',
        reader: 'Stair 1 3rd Floor Emp. Entrance',
        dttm: '2016-10-19 11:37:06 -0400',
        readerKey: '19',
        portalKey: '5',
      },
      {
        logId: 56951,
        personId: '90_JP',
        reader: 'Lobby Door',
        dttm: '2016-10-19 11:37:16 -0400',
        readerKey: '16',
        portalKey: '4',
      },
      {
        logId: 56957,
        personId: '37_KD',
        reader: 'Stair 1 3rd Floor Emp. Entrance',
        dttm: '2016-10-19 11:59:11 -0400',
        readerKey: '19',
        portalKey: '5',
      },
    ];
    const latest = await getAccessHistory(c);
    expect(latest.records.map((r) => r.logId)).toEqual(['56957', '56951', '56948']);
    expect(latest.nextLogId).toBe('-1');

    const since = await getAccessHistory(c, { afterLogId: '56948' });
    expect(since.records.map((r) => r.logId)).toEqual(['56951', '56957']);
    expect(since.records[0]).toMatchObject({
      personId: '90_JP',
      reader: 'Lobby Door',
      readerKey: '16',
      portalKey: '4',
      type: '1',
    });

    const paged = await getAccessHistory(c, { afterLogId: '56948', maxRecords: 1 });
    expect(paged.records).toHaveLength(1);
    expect(paged.nextLogId).toBe('56951');

    const none = await getAccessHistory(c, { afterLogId: '56957' });
    expect(none.notFound).toBe(true);
    expect(none.records).toEqual([]);
  });

  it('wraps FAIL responses in NbapiError', async () => {
    const c = await boot();
    await pingApp(c);
    // GetEventHistory with a shape the fake does not implement → APIERROR 6 → NbapiError
    await expect(c.call('GetEventHistory', { STARTDTTM: 'x' })).rejects.toBeInstanceOf(NbapiError);
  });
});

describe('form body mode', () => {
  it('posts APIcommand= when configured', async () => {
    fake = new FakeNetBox();
    baseUrl = await fake.start();
    const c = new NbapiClient({
      baseUrl,
      username: 'api',
      password: 'secret',
      version: 1,
      bodyMode: 'form',
    });
    expect(await pingApp(c)).toBe(true);
    expect(fake.requests[0]?.body).toContain('<COMMAND name="Login"');
  });
});
