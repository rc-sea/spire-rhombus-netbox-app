/**
 * A fake cloud ingest service for collector tests: records what arrives,
 * acknowledges by id, and can be told to fail, rate-limit or reject auth.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type BridgeEvent,
  type CollectorAction,
  type Heartbeat,
  IngestRequest,
  type InventorySnapshot,
} from '@spire/shared';

export class FakeCloud {
  readonly server: Server;
  secret = 'cloud-secret';
  received = new Map<string, BridgeEvent>();
  ingestCalls = 0;
  heartbeats: Heartbeat[] = [];
  inventories: InventorySnapshot[] = [];
  /** Set to make the next N ingest calls fail with this status. */
  failNext: { status: number; remaining: number } = { status: 500, remaining: 0 };
  /** Ids to reject as invalid on ingest. */
  rejectIds = new Set<string>();
  pendingActions: CollectorAction[] = [];

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.secret}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (req.url) {
      case '/api/ingest/events': {
        this.ingestCalls += 1;
        if (this.failNext.remaining > 0) {
          this.failNext.remaining -= 1;
          return json(this.failNext.status, { error: 'simulated' });
        }
        const parsed = IngestRequest.safeParse(JSON.parse(text));
        if (!parsed.success) return json(400, { error: parsed.error.message });
        const accepted: string[] = [];
        const rejected: { id: string; error: string }[] = [];
        for (const e of parsed.data.events) {
          if (this.rejectIds.has(e.id)) {
            rejected.push({ id: e.id, error: 'simulated rejection' });
            continue;
          }
          this.received.set(e.id, e);
          accepted.push(e.id);
        }
        return json(200, { accepted, rejected });
      }
      case '/api/ingest/heartbeat': {
        this.heartbeats.push(JSON.parse(text) as Heartbeat);
        const actions = this.pendingActions;
        this.pendingActions = [];
        return json(200, { actions });
      }
      case '/api/ingest/inventory': {
        this.inventories.push(JSON.parse(text) as InventorySnapshot);
        return json(200, {});
      }
      default:
        return json(404, { error: 'not found' });
    }
  }
}
