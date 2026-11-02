/**
 * Ingest handlers: pure functions over the Repo, called by the API routes.
 */
import {
  type BridgeEvent,
  type Heartbeat,
  type HeartbeatResponse,
  IngestRequest,
  type IngestResponse,
  type InventorySnapshot,
} from '@spire/shared';
import type { Repo } from './db/repo';
import { resolveTargets } from './mapping';

export interface IngestOutcome {
  response: IngestResponse;
  /** Ids newly stored (for an immediate publish attempt). */
  inserted: string[];
}

/**
 * Validate per event, insert what is new, resolve targets and enqueue jobs.
 * Events the collector re-sends are acknowledged without side effects.
 */
export async function ingestEvents(
  repo: Repo,
  collectorId: string,
  body: unknown,
): Promise<IngestOutcome> {
  const envelope = IngestRequest.safeParse(body);
  const accepted: string[] = [];
  const rejected: { id: string; error: string }[] = [];
  let candidates: BridgeEvent[] = [];
  if (envelope.success) {
    candidates = envelope.data.events;
  } else {
    // Envelope failed: try per-event so one bad event does not reject the batch.
    const raw = (body as { events?: unknown[] } | null)?.events;
    if (!Array.isArray(raw)) {
      return {
        response: { accepted, rejected: [{ id: '*', error: 'invalid request envelope' }] },
        inserted: [],
      };
    }
    const { BridgeEvent: Schema } = await import('@spire/shared');
    for (const item of raw) {
      const r = Schema.safeParse(item);
      if (r.success) candidates.push(r.data);
      else
        rejected.push({
          id: String((item as { id?: unknown })?.id ?? '?'),
          error: r.error.issues[0]?.message ?? 'invalid',
        });
    }
  }
  const own = candidates.filter((e) => e.collectorId === collectorId);
  for (const e of candidates) {
    if (e.collectorId !== collectorId)
      rejected.push({ id: e.id, error: 'collectorId does not match credentials' });
  }
  const inserted = await repo.insertEvents(own);
  const insertedSet = new Set(inserted);
  const [mappings, settings] = await Promise.all([repo.listMappings(), repo.getSettings()]);
  const jobs: { eventId: string; cameraUuid: string }[] = [];
  for (const e of own) {
    accepted.push(e.id);
    if (!insertedSet.has(e.id)) continue; // duplicate: already handled
    if (e.kind === 'netbox-health' || e.kind === 'other') {
      await repo.setEventTargets(e.id, [], 'ignored');
      continue;
    }
    const t = resolveTargets(e, mappings, settings);
    if (t.cameras.length === 0) {
      await repo.setEventTargets(
        e.id,
        [],
        t.matchedBy === 'kind-disabled' ? 'ignored' : 'unmapped',
      );
      continue;
    }
    await repo.setEventTargets(e.id, t.cameras, 'pending');
    for (const cameraUuid of t.cameras) jobs.push({ eventId: e.id, cameraUuid });
  }
  if (jobs.length > 0) await repo.enqueueJobs(jobs);
  return { response: { accepted, rejected }, inserted };
}

export async function recordHeartbeat(
  repo: Repo,
  collectorId: string,
  heartbeat: Heartbeat,
  pendingActions: HeartbeatResponse['actions'],
): Promise<HeartbeatResponse> {
  await repo.touchCollector(collectorId, heartbeat);
  return { actions: pendingActions };
}

export async function recordInventory(repo: Repo, snapshot: InventorySnapshot): Promise<void> {
  await repo.replaceInventory(snapshot.items, snapshot.takenAt);
}
