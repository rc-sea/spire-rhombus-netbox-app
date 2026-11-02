/**
 * A fake NetBox for tests. Speaks enough NBAPI to exercise the client:
 * Login/Logout/PingApp/GetAPIVersion, paged GetReaders/GetPortals,
 * GetAccessHistory with AFTERLOGID, ListEvents, and the event stream with
 * keep-alives. Response bodies mirror the examples in API-UG-22.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
});

export interface FakeAccess {
  logId: number;
  personId: string;
  reader: string;
  dttm: string;
  readerKey: string;
  portalKey: string;
  type?: string;
}

export interface FakeNetBoxOptions {
  username?: string;
  password?: string;
  apiVersion?: string;
  /** Expire the session after this many non-login commands (to test re-login). */
  sessionCommandLimit?: number;
  /** Deny API entirely (APIERROR 2). */
  apiDisabled?: boolean;
  /** Keep-alive interval on the stream, ms. */
  keepAliveMs?: number;
  /** Page size for GetReaders. */
  readerPageSize?: number;
  /** Serve NBAPI under /nbws/… like NetBox 6.x and answer 410 on the legacy paths. */
  nbws?: boolean;
}

export class FakeNetBox {
  readonly server: Server;
  readonly options: Required<FakeNetBoxOptions>;
  sessions = new Map<string, { commands: number }>();
  requests: { path: string; command: string | undefined; body: string }[] = [];
  readers: { key: string; name: string; description?: string }[] = [
    { key: '16', name: 'Lobby Door' },
    { key: '19', name: 'Stair 1 3rd Floor Emp. Entrance' },
    { key: '21', name: 'P1 Garage Entry', description: 'Garage ramp' },
  ];
  portals: {
    key: string;
    name: string;
    readers: { key: string; name: string; order: number }[];
  }[] = [
    { key: '4', name: 'Lobby', readers: [{ key: '16', name: 'Lobby Door', order: 1 }] },
    {
      key: '5',
      name: 'Stair 1 3rd',
      readers: [{ key: '19', name: 'Stair 1 3rd Floor Emp. Entrance', order: 1 }],
    },
  ];
  events: string[] = ['158_backDoorForcedEvent', 'Motion detected at the Cafe'];
  accesses: FakeAccess[] = [];
  /** Open stream responses, so tests can push events and drop connections. */
  streams = new Set<ServerResponse>();
  private sessionCounter = 0;
  private keepAliveTimers = new Map<ServerResponse, NodeJS.Timeout>();

  constructor(opts: FakeNetBoxOptions = {}) {
    this.options = {
      username: opts.username ?? 'api',
      password: opts.password ?? 'secret',
      apiVersion: opts.apiVersion ?? '4.7',
      sessionCommandLimit: opts.sessionCommandLimit ?? Number.POSITIVE_INFINITY,
      apiDisabled: opts.apiDisabled ?? false,
      keepAliveMs: opts.keepAliveMs ?? 10_000,
      readerPageSize: opts.readerPageSize ?? 100,
      nbws: opts.nbws ?? false,
    };
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const t of this.keepAliveTimers.values()) clearInterval(t);
    for (const s of this.streams) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Push an event to every open stream. */
  emit(tags: Record<string, string>): void {
    const body = Object.entries(tags)
      .map(([k, v]) => `   <${k}><![CDATA[${v}]]></${k}>`)
      .join('\n');
    const doc = `<NETBOX>\n <RESPONSE command="StreamEvents">\n  <EVENT>\n${body}\n  </EVENT>\n </RESPONSE>\n</NETBOX>\n`;
    for (const s of this.streams) s.write(doc);
  }

  /** Drop every open stream connection without a clean close. */
  dropStreams(): void {
    for (const s of this.streams) s.destroy();
  }

  get openStreamCount(): number {
    return this.streams.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body = Buffer.concat(chunks).toString('utf8');
    if (body.startsWith('APIcommand=')) body = decodeURIComponent(body.slice('APIcommand='.length));
    let path = req.url ?? '/';
    if (this.options.nbws) {
      if (!path.startsWith('/nbws/')) {
        this.requests.push({ path, command: undefined, body });
        res.writeHead(410, { 'content-type': 'text/plain' });
        return res.end('Gone');
      }
      path = path.slice('/nbws'.length);
    } else if (path.startsWith('/nbws/')) {
      this.requests.push({ path, command: undefined, body });
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not Found');
    }
    let command: string | undefined;
    let sessionId: string | undefined;
    let params: Record<string, unknown> = {};
    try {
      const doc = parser.parse(body) as Record<string, unknown>;
      const api = doc['NETBOX-API'] as Record<string, unknown> | undefined;
      const cmd = api?.COMMAND as Record<string, unknown> | undefined;
      command = typeof cmd?.['@_name'] === 'string' ? (cmd['@_name'] as string) : undefined;
      sessionId =
        typeof api?.['@_sessionid'] === 'string' ? (api['@_sessionid'] as string) : undefined;
      params = (cmd?.PARAMS as Record<string, unknown>) ?? {};
    } catch {
      // fall through: APIERROR 4
    }
    this.requests.push({ path, command, body });
    if (this.options.apiDisabled) return this.send(res, apiError(2));
    if (!command) return this.send(res, apiError(4));

    if (path === '/appdevent/nbapi/event') {
      if (command !== 'StreamEvents') return this.send(res, apiError(3));
      const cookieSession = /\.sessionid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (!cookieSession || !this.sessions.has(cookieSession)) return this.send(res, apiError(5));
      return this.startStream(res);
    }

    if (command === 'Login') {
      if (params.USERNAME !== this.options.username || params.PASSWORD !== this.options.password) {
        return this.send(res, apiError(5));
      }
      const id = `sess${++this.sessionCounter}`;
      this.sessions.set(id, { commands: 0 });
      return this.send(
        res,
        `<NETBOX sessionid="${id}">\n <RESPONSE command="Login" num="1">\n  <CODE>SUCCESS</CODE>\n </RESPONSE>\n</NETBOX>`,
      );
    }

    const sess = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sess) return this.send(res, apiError(5));
    sess.commands += 1;
    if (sess.commands > this.options.sessionCommandLimit) {
      this.sessions.delete(sessionId as string);
      return this.send(res, apiError(5));
    }
    const ok = (inner: string) =>
      `<NETBOX sessionid="${sessionId}">\n <RESPONSE command="${command}" num="1">\n  <CODE>SUCCESS</CODE>\n${inner} </RESPONSE>\n</NETBOX>`;

    switch (command) {
      case 'Logout':
        this.sessions.delete(sessionId as string);
        return this.send(
          res,
          `<NETBOX>\n <RESPONSE command="Logout" num="1">\n  <CODE>SUCCESS</CODE>\n </RESPONSE>\n</NETBOX>`,
        );
      case 'PingApp':
        return this.send(res, ok(''));
      case 'GetAPIVersion':
        return this.send(
          res,
          ok(`  <DETAILS>\n   <APIVERSION>${this.options.apiVersion}</APIVERSION>\n  </DETAILS>\n`),
        );
      case 'GetReaders': {
        const start = Number(params.STARTFROMKEY ?? 0);
        const sorted = [...this.readers].sort((a, b) => Number(a.key) - Number(b.key));
        const from = sorted.filter((r) => Number(r.key) >= start);
        const page = from.slice(0, this.options.readerPageSize);
        const next = from.length > page.length ? from[page.length]?.key : '-1';
        const items = page
          .map(
            (r) =>
              `    <READER>\n     <READERKEY>${r.key}</READERKEY>\n     <NAME>${r.name}</NAME>\n     <DESCRIPTION>${r.description ?? ''}</DESCRIPTION>\n    </READER>`,
          )
          .join('\n');
        return this.send(
          res,
          ok(
            `  <DETAILS>\n   <READERS>\n${items}\n   </READERS>\n   <NEXTKEY>${next}</NEXTKEY>\n  </DETAILS>\n`,
          ),
        );
      }
      case 'GetPortals': {
        const items = this.portals
          .map((p) => {
            const rs = p.readers
              .map(
                (r) =>
                  `      <READER>\n       <READERKEY>${r.key}</READERKEY>\n       <NAME>${r.name}</NAME>\n       <DESCRIPTION></DESCRIPTION>\n       <PORTALORDER>${r.order}</PORTALORDER>\n      </READER>`,
              )
              .join('\n');
            return `    <PORTAL>\n     <NAME>${p.name}</NAME>\n     <PORTALKEY>${p.key}</PORTALKEY>\n     <READERS>\n${rs}\n     </READERS>\n    </PORTAL>`;
          })
          .join('\n');
        return this.send(
          res,
          ok(
            `  <DETAILS>\n   <PORTALS>\n${items}\n   </PORTALS>\n   <NEXTKEY>-1</NEXTKEY>\n  </DETAILS>\n`,
          ),
        );
      }
      case 'GetElevators':
        return this.send(
          res,
          ok(
            `  <DETAILS>\n   <ELEVATORS>\n    <ELEVATOR>\n     <ELEVATORKEY>1</ELEVATORKEY>\n     <NAME>Compass Bank A</NAME>\n    </ELEVATOR>\n   </ELEVATORS>\n   <NEXTKEY>-1</NEXTKEY>\n  </DETAILS>\n`,
          ),
        );
      case 'GetFloors':
        return this.send(
          res,
          ok(
            `  <DETAILS>\n   <FLOORS>\n    <FLOOR>\n     <FLOORKEY>14</FLOORKEY>\n     <NAME>14</NAME>\n    </FLOOR>\n   </FLOORS>\n   <NEXTKEY>-1</NEXTKEY>\n  </DETAILS>\n`,
          ),
        );
      case 'ListEvents': {
        if (path !== '/appd/nbapi') return this.send(res, apiError(3));
        const items = this.events
          .map((e) => `    <EVENT>\n     <NAME>${e}</NAME>\n    </EVENT>`)
          .join('\n');
        return this.send(
          res,
          ok(`  <DETAILS>\n   <EVENTS>\n${items}\n   </EVENTS>\n  </DETAILS>\n`),
        );
      }
      case 'GetAccessHistory': {
        const after = params.AFTERLOGID !== undefined ? Number(params.AFTERLOGID) : undefined;
        const max = params.MAXRECORDS !== undefined ? Number(params.MAXRECORDS) : undefined;
        let list = [...this.accesses];
        if (after !== undefined)
          list = list.filter((a) => a.logId > after).sort((a, b) => a.logId - b.logId);
        else list.sort((a, b) => b.logId - a.logId);
        if (after !== undefined && list.length === 0) {
          return this.send(
            res,
            `<NETBOX sessionid="${sessionId}">\n <RESPONSE command="GetAccessHistory" num="1">\n  <CODE>NOT FOUND</CODE>\n </RESPONSE>\n</NETBOX>`,
          );
        }
        const page = max !== undefined ? list.slice(0, max) : list;
        const nextLogId = page.length < list.length ? String(page[page.length - 1]?.logId) : '-1';
        const items = page
          .map(
            (a) =>
              `    <ACCESS>\n     <LOGID>${a.logId}</LOGID>\n     <PERSONID>${a.personId}</PERSONID>\n     <READER>${a.reader}</READER>\n     <DTTM>${a.dttm}</DTTM>\n     <NODEDTTM>${a.dttm}</NODEDTTM>\n     <TYPE>${a.type ?? '1'}</TYPE>\n     <REASON></REASON>\n     <READERKEY>${a.readerKey}</READERKEY>\n     <PORTALKEY>${a.portalKey}</PORTALKEY>\n    </ACCESS>`,
          )
          .join('\n');
        return this.send(
          res,
          ok(
            `  <DETAILS>\n   <ACCESSES>\n${items}\n   </ACCESSES>\n   <NEXTLOGID>${nextLogId}</NEXTLOGID>\n  </DETAILS>\n`,
          ),
        );
      }
      case 'AddPerson':
      case 'UnlockPortal':
      case 'TriggerEvent':
        // A real NetBox would act. The fake records it so tests can assert it never happens.
        return this.send(res, ok(''));
      default:
        return this.send(res, apiError(6));
    }
  }

  private startStream(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/xml', 'transfer-encoding': 'chunked' });
    res.write(
      `<NETBOX>\n <RESPONSE command="StreamEvents">\n  <CODE>SUCCESS</CODE>\n </RESPONSE>\n</NETBOX>\n`,
    );
    this.streams.add(res);
    const t = setInterval(() => {
      if (!res.destroyed)
        res.write(`<NETBOX>\n <RESPONSE command="StreamEvents">\n </RESPONSE>\n</NETBOX>\n`);
    }, this.options.keepAliveMs);
    this.keepAliveTimers.set(res, t);
    res.on('close', () => {
      clearInterval(t);
      this.keepAliveTimers.delete(res);
      this.streams.delete(res);
    });
  }

  private send(res: ServerResponse, xml: string): void {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(xml);
  }
}

function apiError(n: number): string {
  return `<NETBOX>\n <RESPONSE>\n  <APIERROR>${n}</APIERROR>\n </RESPONSE>\n</NETBOX>`;
}
