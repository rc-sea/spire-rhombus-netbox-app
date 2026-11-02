/**
 * Gap recovery: fetch access records newer than the last delivered LOGID via
 * GetAccessHistory AFTERLOGID and spool them as `source: "history"` events.
 * On first run (no LOGID stored) it only records the newest LOGID so we do not
 * replay the whole log on a fresh install.
 */
import type { Logger } from 'pino';
import type { NbapiClient } from './nbapi/client.js';
import { getAccessHistory } from './nbapi/commands.js';
import { fromAccessRecord, type NormalizeContext } from './normalize.js';
import { KV_LAST_LOG_ID, KV_LAST_RECONCILE_AT, type Spool } from './spool.js';

export interface ReconcileResult {
  newRecords: number;
  error: string | null;
  lastLogId: string | undefined;
}

export interface ReconcileOptions {
  pageSize?: number;
  /** Delay between pages so a long catch-up does not flood NetBox or the spool. */
  pageDelayMs?: number;
  maxPages?: number;
}

export async function reconcile(
  netbox: NbapiClient,
  spool: Spool,
  ctx: NormalizeContext,
  log: Logger,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const pageSize = opts.pageSize ?? 100;
  const pageDelayMs = opts.pageDelayMs ?? 1_000;
  const maxPages = opts.maxPages ?? 1_000;
  const result: ReconcileResult = {
    newRecords: 0,
    error: null,
    lastLogId: spool.get(KV_LAST_LOG_ID),
  };
  try {
    if (result.lastLogId === undefined) {
      // Fresh install: establish the high-water mark without replaying history.
      const latest = await getAccessHistory(netbox, { maxRecords: 1 });
      const top = latest.records[0]?.logId;
      if (top) {
        spool.set(KV_LAST_LOG_ID, top);
        result.lastLogId = top;
        log.info({ lastLogId: top }, 'reconcile: initialised high-water mark');
      }
      spool.set(KV_LAST_RECONCILE_AT, new Date().toISOString());
      return result;
    }
    let after = result.lastLogId;
    for (let page = 0; page < maxPages; page++) {
      const res = await getAccessHistory(netbox, { afterLogId: after, maxRecords: pageSize });
      if (res.notFound || res.records.length === 0) break;
      const received = new Date();
      const events = res.records.map((r) => fromAccessRecord(r, ctx, received));
      spool.enqueue(events);
      result.newRecords += events.length;
      const last = res.records[res.records.length - 1]?.logId;
      if (!last) break;
      after = last;
      spool.set(KV_LAST_LOG_ID, last);
      result.lastLogId = last;
      if (res.nextLogId === '-1' || res.nextLogId === undefined || res.records.length < pageSize)
        break;
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }
    spool.set(KV_LAST_RECONCILE_AT, new Date().toISOString());
    if (result.newRecords > 0)
      log.info(
        { newRecords: result.newRecords, lastLogId: result.lastLogId },
        'reconcile: recovered records',
      );
  } catch (err) {
    result.error = (err as Error).message;
    log.warn({ err: result.error }, 'reconcile failed');
  }
  return result;
}
