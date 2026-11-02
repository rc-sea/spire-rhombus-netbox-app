import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NbapiClient, NbapiWrongPathError } from '../src/nbapi/client.js';
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

describe('path families and probe', () => {
  it('auto-probe picks legacy on a pre-6.x unit', async () => {
    const c = await boot({ apiVersion: '4.7' });
    const r = await c.probe();
    expect(r.pathFamily).toBe('legacy');
    expect(r.apiVersion).toBe('4.7');
    expect(r.tried).toHaveLength(1);
    expect(c.paths.commands).toBe('/goforms/nbapi');
    expect(c.isLoggedIn).toBe(true);
  });

  it('auto-probe falls through to nbws on a 6.x unit that answers 410 on legacy paths', async () => {
    const c = await boot({ nbws: true, apiVersion: '6.2' });
    const r = await c.probe();
    expect(r.pathFamily).toBe('nbws');
    expect(r.apiVersion).toBe('6.2');
    expect(r.tried.map((t) => t.family)).toEqual(['legacy', 'nbws']);
    expect(r.tried[0]?.outcome).toMatch(/410/);
    expect(c.paths.commands).toBe('/nbws/goforms/nbapi');
    expect(c.paths.stream).toBe('/nbws/appdevent/nbapi/event');
    expect(await pingApp(c)).toBe(true);
  });

  it('a configured family is tried first, then the other', async () => {
    fake = new FakeNetBox({ nbws: false });
    baseUrl = await fake.start();
    const c = new NbapiClient({
      baseUrl,
      username: 'api',
      password: 'secret',
      version: 'auto',
      pathFamily: 'nbws',
    });
    const r = await c.probe();
    expect(r.tried.map((t) => t.family)).toEqual(['nbws', 'legacy']);
    expect(r.pathFamily).toBe('legacy');
  });

  it('a fixed family without probe surfaces 410 as NbapiWrongPathError', async () => {
    fake = new FakeNetBox({ nbws: true });
    baseUrl = await fake.start();
    const c = new NbapiClient({
      baseUrl,
      username: 'api',
      password: 'secret',
      version: 2,
      pathFamily: 'legacy',
    });
    await expect(pingApp(c)).rejects.toBeInstanceOf(NbapiWrongPathError);
  });

  it('probe does not mask bad credentials as a path problem', async () => {
    fake = new FakeNetBox();
    baseUrl = await fake.start();
    const c = new NbapiClient({ baseUrl, username: 'api', password: 'nope', version: 'auto' });
    await expect(c.probe()).rejects.toBeInstanceOf(NbapiAuthError);
  });
});
