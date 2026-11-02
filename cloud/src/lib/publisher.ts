/**
 * Drain publish jobs to Rhombus: group by camera, one call per camera,
 * backoff on retryable errors, individual retry then fail on validation errors.
 */
import type { Repo } from './db/repo';
import { resolveTargets } from './mapping';
import type { RhombusClient } from './rhombus';
import { RhombusError } from './rhombus';
import { type Seekpoint, toSeekpoint } from './seekpoint';

export interface PublishOptions {
  limit?: number;
  now?: () => Date;
  /** Give up on a job after this many attempts (≈ 24 h with the backoff below). */
  maxAttempts?: number;
}

export interface PublishSummary {
  considered: number;
  published: number;
  retried: number;
  failed: number;
  cameras: number;
}

export function backoffMs(attempt: number): number {
  // 1 min, 2, 4, … capped at 1 h. 24 attempts ≈ 24 h.
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export async function publishDue(
  repo: Repo,
  rhombus: RhombusClient,
  opts: PublishOptions = {},
): Promise<PublishSummary> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 500;
  const maxAttempts = opts.maxAttempts ?? 24;
  const jobs = await repo.dueJobs(limit, now().toISOString());
  const summary: PublishSummary = {
    considered: jobs.length,
    published: 0,
    retried: 0,
    failed: 0,
    cameras: 0,
  };
  if (jobs.length === 0) return summary;

  const [mappings, settings] = await Promise.all([repo.listMappings(), repo.getSettings()]);
  const byCamera = new Map<string, { jobId: number; eventId: string; point: Seekpoint }[]>();
  for (const job of jobs) {
    const ev = await repo.getEvent(job.eventId);
    if (!ev) {
      await repo.markJobsFailed([job.id], 'EVENT_MISSING');
      summary.failed += 1;
      continue;
    }
    const t = resolveTargets(
      {
        schemaVersion: 1,
        id: ev.id,
        collectorId: ev.collectorId,
        source: ev.source,
        kind: ev.kind,
        occurredAt: ev.occurredAt,
        receivedAt: ev.receivedAt,
        netbox: ev.netbox,
      },
      mappings,
      settings,
    );
    const point = toSeekpoint(
      {
        schemaVersion: 1,
        id: ev.id,
        collectorId: ev.collectorId,
        source: ev.source,
        kind: ev.kind,
        occurredAt: ev.occurredAt,
        receivedAt: ev.receivedAt,
        netbox: ev.netbox,
      },
      { overlay: t.overlay, colorOverride: t.colorOverride },
    );
    const list = byCamera.get(job.cameraUuid) ?? [];
    list.push({ jobId: job.id, eventId: job.eventId, point });
    byCamera.set(job.cameraUuid, list);
  }
  summary.cameras = byCamera.size;

  for (const [cameraUuid, items] of byCamera) {
    const ids = items.map((i) => i.jobId);
    const attemptOf = new Map(jobs.map((j) => [j.id, j.attempts]));
    try {
      await rhombus.createSeekpoints(
        cameraUuid,
        items.map((i) => i.point),
      );
      await repo.markJobsPublished(ids, now().toISOString());
      summary.published += ids.length;
    } catch (err) {
      if (err instanceof RhombusError && err.retryable) {
        const next = new Date(
          now().getTime() + backoffMs((attemptOf.get(ids[0] ?? -1) ?? 0) + 1),
        ).toISOString();
        const exhausted = ids.filter((id) => (attemptOf.get(id) ?? 0) + 1 >= maxAttempts);
        const retry = ids.filter((id) => !exhausted.includes(id));
        if (retry.length)
          await repo.markJobsRetry(retry, next, err.errorCode ?? `HTTP_${err.status}`);
        if (exhausted.length)
          await repo.markJobsFailed(exhausted, err.errorCode ?? `HTTP_${err.status}`);
        summary.retried += retry.length;
        summary.failed += exhausted.length;
        continue;
      }
      // Non-retryable for the batch: try each point alone once, fail the rest.
      for (const item of items) {
        try {
          await rhombus.createSeekpoints(cameraUuid, [item.point]);
          await repo.markJobsPublished([item.jobId], now().toISOString());
          summary.published += 1;
        } catch (e2) {
          const code =
            e2 instanceof RhombusError ? (e2.errorCode ?? `HTTP_${e2.status}`) : 'UNKNOWN';
          await repo.markJobsFailed([item.jobId], code);
          summary.failed += 1;
        }
      }
    }
  }

  // Roll job states up to event status.
  const eventIds = [...new Set(jobs.map((j) => j.eventId))];
  for (const eventId of eventIds) {
    const all = await repo.jobsForEvent(eventId);
    const pub = all.filter((j) => j.status === 'published').length;
    const fail = all.filter((j) => j.status === 'failed').length;
    if (pub === all.length) await repo.updateEventStatus(eventId, 'published');
    else if (fail === all.length) await repo.updateEventStatus(eventId, 'failed');
    else if (pub > 0 || fail > 0)
      await repo.updateEventStatus(eventId, pub > 0 ? 'partial' : 'pending');
  }
  return summary;
}
