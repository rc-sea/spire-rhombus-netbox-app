/**
 * Repo backed by Supabase Postgres via the service-role key (server only).
 */
import type { BridgeEvent, Heartbeat, InventoryItem } from '@spire/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '../env';
import type {
  CameraRow,
  CollectorRow,
  EventQuery,
  EventRow,
  EventStatus,
  Mapping,
  PublishJob,
  Repo,
  Settings,
} from './repo';

type Row = Record<string, unknown>;

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null) throw new Error(`${what}: no data`);
  return r.data;
}

function eventRow(r: Row): EventRow {
  return {
    id: r.id as string,
    collectorId: r.collector_id as string,
    source: r.source as EventRow['source'],
    kind: r.kind as EventRow['kind'],
    occurredAt: r.occurred_at as string,
    receivedAt: r.received_at as string,
    ingestedAt: r.ingested_at as string,
    netbox: r.netbox as EventRow['netbox'],
    status: r.status as EventStatus,
    targetCameras: (r.target_cameras as string[]) ?? [],
  };
}

function jobRow(r: Row): PublishJob {
  return {
    id: Number(r.id),
    eventId: r.event_id as string,
    cameraUuid: r.camera_uuid as string,
    status: r.status as PublishJob['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at as string,
    lastErrorCode: (r.last_error_code as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
  };
}

export class SupabaseRepo implements Repo {
  constructor(private readonly db: SupabaseClient) {}

  static fromEnv(): SupabaseRepo {
    const env = serverEnv();
    return new SupabaseRepo(
      createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
  }

  async getCollector(id: string): Promise<CollectorRow | null> {
    const r = await this.db.from('collectors').select('*').eq('id', id).maybeSingle();
    if (r.error) throw new Error(`getCollector: ${r.error.message}`);
    if (!r.data) return null;
    const d = r.data as Row;
    return {
      id: d.id as string,
      name: d.name as string,
      secretHash: d.secret_hash as string,
      lastSeenAt: (d.last_seen_at as string | null) ?? null,
      lastHeartbeat: (d.last_heartbeat as Heartbeat | null) ?? null,
    };
  }

  async touchCollector(id: string, heartbeat: Heartbeat): Promise<void> {
    const r = await this.db
      .from('collectors')
      .update({ last_seen_at: heartbeat.sentAt, last_heartbeat: heartbeat })
      .eq('id', id);
    if (r.error) throw new Error(`touchCollector: ${r.error.message}`);
  }

  async insertEvents(events: BridgeEvent[]): Promise<string[]> {
    if (events.length === 0) return [];
    const rows = events.map((e) => ({
      id: e.id,
      collector_id: e.collectorId,
      source: e.source,
      kind: e.kind,
      occurred_at: e.occurredAt,
      received_at: e.receivedAt,
      netbox: e.netbox,
    }));
    // ON CONFLICT DO NOTHING, returning what was actually inserted.
    const r = await this.db
      .from('events')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');
    if (r.error) throw new Error(`insertEvents: ${r.error.message}`);
    return (r.data as { id: string }[]).map((x) => x.id);
  }

  async getEvent(id: string): Promise<EventRow | null> {
    const r = await this.db.from('events').select('*').eq('id', id).maybeSingle();
    if (r.error) throw new Error(`getEvent: ${r.error.message}`);
    return r.data ? eventRow(r.data as Row) : null;
  }

  async setEventTargets(id: string, cameras: string[], status: EventStatus): Promise<void> {
    const r = await this.db.from('events').update({ target_cameras: cameras, status }).eq('id', id);
    if (r.error) throw new Error(`setEventTargets: ${r.error.message}`);
  }

  async updateEventStatus(id: string, status: EventStatus): Promise<void> {
    const r = await this.db.from('events').update({ status }).eq('id', id);
    if (r.error) throw new Error(`updateEventStatus: ${r.error.message}`);
  }

  async queryEvents(q: EventQuery): Promise<EventRow[]> {
    let qb = this.db
      .from('events')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(Math.min(q.limit ?? 100, 1000));
    if (q.from) qb = qb.gte('occurred_at', q.from);
    if (q.to) qb = qb.lte('occurred_at', q.to);
    if (q.kind) qb = qb.eq('kind', q.kind);
    if (q.status) qb = qb.eq('status', q.status);
    if (q.reader) qb = qb.ilike('netbox->>readerName', `%${q.reader}%`);
    if (q.person) qb = qb.ilike('netbox->>personName', `%${q.person}%`);
    const r = await qb;
    if (r.error) throw new Error(`queryEvents: ${r.error.message}`);
    return (r.data as Row[]).map(eventRow);
  }

  async enqueueJobs(jobs: { eventId: string; cameraUuid: string }[]): Promise<void> {
    if (jobs.length === 0) return;
    const r = await this.db.from('publish_jobs').upsert(
      jobs.map((j) => ({ event_id: j.eventId, camera_uuid: j.cameraUuid })),
      { onConflict: 'event_id,camera_uuid', ignoreDuplicates: true },
    );
    if (r.error) throw new Error(`enqueueJobs: ${r.error.message}`);
  }

  async dueJobs(limit: number, now: string): Promise<PublishJob[]> {
    const r = await this.db
      .from('publish_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', now)
      .order('id', { ascending: true })
      .limit(limit);
    if (r.error) throw new Error(`dueJobs: ${r.error.message}`);
    return (r.data as Row[]).map(jobRow);
  }

  async markJobsPublished(ids: number[], at: string): Promise<void> {
    if (ids.length === 0) return;
    const r = await this.db.rpc('mark_jobs_published', { job_ids: ids, at });
    if (r.error) throw new Error(`markJobsPublished: ${r.error.message}`);
  }

  async markJobsRetry(ids: number[], nextAttemptAt: string, errorCode: string): Promise<void> {
    if (ids.length === 0) return;
    const r = await this.db.rpc('mark_jobs_retry', {
      job_ids: ids,
      next_at: nextAttemptAt,
      code: errorCode,
    });
    if (r.error) throw new Error(`markJobsRetry: ${r.error.message}`);
  }

  async markJobsFailed(ids: number[], errorCode: string): Promise<void> {
    if (ids.length === 0) return;
    const r = await this.db.rpc('mark_jobs_failed', { job_ids: ids, code: errorCode });
    if (r.error) throw new Error(`markJobsFailed: ${r.error.message}`);
  }

  async jobsForEvent(eventId: string): Promise<PublishJob[]> {
    const r = await this.db.from('publish_jobs').select('*').eq('event_id', eventId);
    if (r.error) throw new Error(`jobsForEvent: ${r.error.message}`);
    return (r.data as Row[]).map(jobRow);
  }

  async countPendingJobs(): Promise<number> {
    const r = await this.db
      .from('publish_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (r.error) throw new Error(`countPendingJobs: ${r.error.message}`);
    return r.count ?? 0;
  }

  async listMappings(): Promise<Mapping[]> {
    const r = await this.db.from('mappings').select('*');
    if (r.error) throw new Error(`listMappings: ${r.error.message}`);
    return (r.data as Row[]).map((m) => ({
      id: Number(m.id),
      sourceType: m.source_type as Mapping['sourceType'],
      sourceKey: m.source_key as string,
      sourceNameSnapshot: m.source_name_snapshot as string,
      cameraUuid: m.camera_uuid as string,
      enabled: Boolean(m.enabled),
      overlay: (m.overlay as boolean | null) ?? null,
      colorOverride: (m.color_override as Mapping['colorOverride']) ?? null,
    }));
  }

  async getSettings(): Promise<Settings> {
    const d = must(
      await this.db.from('settings').select('*').eq('id', 1).single(),
      'getSettings',
    ) as Row;
    return {
      unmappedPolicy: d.unmapped_policy as Settings['unmappedPolicy'],
      catchAllCamera: (d.catch_all_camera as string | null) ?? null,
      publishKinds: (d.publish_kinds as string[]) ?? [],
      overlayKinds: (d.overlay_kinds as string[]) ?? [],
      quietHours: d.quiet_hours as Settings['quietHours'],
      eventSilenceHours: Number(d.event_silence_hours),
      alertRecipients: (d.alert_recipients as string[]) ?? [],
      slackWebhook: (d.slack_webhook as string | null) ?? null,
    };
  }

  async listCameras(): Promise<CameraRow[]> {
    const r = await this.db.from('rhombus_cameras').select('*').order('name');
    if (r.error) throw new Error(`listCameras: ${r.error.message}`);
    return (r.data as Row[]).map((c) => ({
      uuid: c.uuid as string,
      name: c.name as string,
      location: (c.location as string | null) ?? null,
      missing: Boolean(c.missing),
    }));
  }

  async upsertCameras(
    cameras: { uuid: string; name: string; location: string | null }[],
  ): Promise<void> {
    const seenAt = new Date().toISOString();
    if (cameras.length > 0) {
      const r = await this.db.from('rhombus_cameras').upsert(
        cameras.map((c) => ({
          uuid: c.uuid,
          name: c.name,
          location: c.location,
          seen_at: seenAt,
          missing: false,
        })),
        { onConflict: 'uuid' },
      );
      if (r.error) throw new Error(`upsertCameras: ${r.error.message}`);
    }
    const r2 = await this.db
      .from('rhombus_cameras')
      .update({ missing: true })
      .lt('seen_at', seenAt);
    if (r2.error) throw new Error(`upsertCameras(missing): ${r2.error.message}`);
  }

  async replaceInventory(items: InventoryItem[], seenAt: string): Promise<void> {
    if (items.length > 0) {
      const r = await this.db.from('netbox_inventory').upsert(
        items.map((i) => ({
          type: i.type,
          key: i.key,
          name: i.name,
          description: i.description ?? null,
          readers: i.readers ?? null,
          raw: i.raw ?? null,
          seen_at: seenAt,
          missing: false,
        })),
        { onConflict: 'type,key' },
      );
      if (r.error) throw new Error(`replaceInventory: ${r.error.message}`);
    }
    const r2 = await this.db
      .from('netbox_inventory')
      .update({ missing: true })
      .lt('seen_at', seenAt);
    if (r2.error) throw new Error(`replaceInventory(missing): ${r2.error.message}`);
  }

  async audit(entry: {
    actor: string;
    action: string;
    objectType: string;
    objectId?: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    const r = await this.db.from('audit_log').insert({
      actor: entry.actor,
      action: entry.action,
      object_type: entry.objectType,
      object_id: entry.objectId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    if (r.error) throw new Error(`audit: ${r.error.message}`);
  }
}
