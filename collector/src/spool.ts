/**
 * Durable local spool on node:sqlite. Holds undelivered BridgeEvents and a
 * small key/value area (last delivered access LOGID, last reconcile time).
 * Bounded by count and age: oldest entries are dropped beyond the limits.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type BridgeEvent, BridgeEvent as BridgeEventSchema } from '@spire/shared';

export interface SpoolOptions {
  path: string; // ':memory:' for tests
  maxEvents?: number;
  maxAgeDays?: number;
}

export class Spool {
  private readonly db: DatabaseSync;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;

  constructor(opts: SpoolOptions) {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    this.maxEvents = opts.maxEvents ?? 100_000;
    this.maxAgeMs = (opts.maxAgeDays ?? 7) * 86_400_000;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT NOT NULL UNIQUE,
        json       TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Insert events; ids already present are ignored. Returns how many were new. */
  enqueue(events: BridgeEvent[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO events (id, json, created_ms) VALUES (?, ?, ?)',
    );
    let added = 0;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        const r = stmt.run(e.id, JSON.stringify(e), now);
        added += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.trim();
    return added;
  }

  /** Oldest-first page of undelivered events. */
  peek(limit: number): BridgeEvent[] {
    const rows = this.db.prepare('SELECT json FROM events ORDER BY seq ASC LIMIT ?').all(limit) as {
      json: string;
    }[];
    const out: BridgeEvent[] = [];
    for (const r of rows) {
      const parsed = BridgeEventSchema.safeParse(JSON.parse(r.json));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /** Remove acknowledged events by id. */
  ack(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM events WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) stmt.run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  size(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return Number(r.n);
  }

  /** Drop events beyond the age and count bounds (oldest first). */
  trim(): number {
    const before = this.size();
    const cutoff = Date.now() - this.maxAgeMs;
    this.db.prepare('DELETE FROM events WHERE created_ms <= ?').run(cutoff);
    const n = this.size();
    if (n > this.maxEvents) {
      this.db
        .prepare(
          'DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq ASC LIMIT ?)',
        )
        .run(n - this.maxEvents);
    }
    return before - this.size();
  }

  get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

export const KV_LAST_LOG_ID = 'lastLogId';
export const KV_LAST_RECONCILE_AT = 'lastReconcileAt';
