import type { BridgeEvent, Heartbeat, InventoryItem } from '@spire/shared';
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
} from '@/lib/db/repo';

export class MemoryRepo implements Repo {
  collectors = new Map<string, CollectorRow>();
  events = new Map<string, EventRow>();
  jobs: PublishJob[] = [];
  mappings: Mapping[] = [];
  cameras = new Map<string, CameraRow>();
  inventory: InventoryItem[] = [];
  auditLog: unknown[] = [];
  settings: Settings = {
    unmappedPolicy: 'ignore',
    catchAllCamera: null,
    publishKinds: [
      'access-granted',
      'access-denied',
      'access-not-completed',
      'door-forced',
      'door-held',
      'door-restored',
      'door-unlock',
      'elevator-granted',
      'elevator-denied',
      'elevator-free-access',
      'elevator-not-completed',
      'event-activated',
    ],
    overlayKinds: ['door-forced', 'access-denied'],
    quietHours: { start: '01:00', end: '05:00', days: [0, 1, 2, 3, 4, 5, 6] },
    eventSilenceHours: 4,
    alertRecipients: [],
    slackWebhook: null,
  };
  private jobSeq = 0;

  async getCollector(id: string) {
    return this.collectors.get(id) ?? null;
  }
  async touchCollector(id: string, heartbeat: Heartbeat) {
    const c = this.collectors.get(id);
    if (c) {
      c.lastSeenAt = heartbeat.sentAt;
      c.lastHeartbeat = heartbeat;
    }
  }
  async insertEvents(events: BridgeEvent[]) {
    const inserted: string[] = [];
    for (const e of events) {
      if (this.events.has(e.id)) continue;
      this.events.set(e.id, {
        id: e.id,
        collectorId: e.collectorId,
        source: e.source,
        kind: e.kind,
        occurredAt: e.occurredAt,
        receivedAt: e.receivedAt,
        ingestedAt: new Date().toISOString(),
        netbox: e.netbox,
        status: 'pending',
        targetCameras: [],
      });
      inserted.push(e.id);
    }
    return inserted;
  }
  async getEvent(id: string) {
    return this.events.get(id) ?? null;
  }
  async setEventTargets(id: string, cameras: string[], status: EventStatus) {
    const e = this.events.get(id);
    if (e) {
      e.targetCameras = cameras;
      e.status = status;
    }
  }
  async updateEventStatus(id: string, status: EventStatus) {
    const e = this.events.get(id);
    if (e) e.status = status;
  }
  async queryEvents(q: EventQuery) {
    return [...this.events.values()]
      .filter((e) => !q.from || e.occurredAt >= q.from)
      .filter((e) => !q.to || e.occurredAt <= q.to)
      .filter((e) => !q.kind || e.kind === q.kind)
      .filter((e) => !q.reader || (e.netbox.readerName ?? '').toLowerCase().includes(q.reader.toLowerCase()))
      .filter((e) => !q.person || (e.netbox.personName ?? '').toLowerCase().includes(q.person.toLowerCase()))
      .filter((e) => !q.status || e.status === q.status)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
      .slice(0, q.limit ?? 100);
  }
  async enqueueJobs(jobs: { eventId: string; cameraUuid: string }[]) {
    for (const j of jobs) {
      if (this.jobs.some((x) => x.eventId === j.eventId && x.cameraUuid === j.cameraUuid)) continue;
      this.jobs.push({
        id: ++this.jobSeq,
        eventId: j.eventId,
        cameraUuid: j.cameraUuid,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(0).toISOString(),
        lastErrorCode: null,
        publishedAt: null,
      });
    }
  }
  async dueJobs(limit: number, now: string) {
    return this.jobs
      .filter((j) => j.status === 'pending' && j.nextAttemptAt <= now)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }
  async markJobsPublished(ids: number[], at: string) {
    for (const j of this.jobs) {
      if (ids.includes(j.id)) {
        j.status = 'published';
        j.publishedAt = at;
        j.attempts += 1;
        j.lastErrorCode = null;
      }
    }
  }
  async markJobsRetry(ids: number[], nextAttemptAt: string, errorCode: string) {
    for (const j of this.jobs) {
      if (ids.includes(j.id)) {
        j.attempts += 1;
        j.nextAttemptAt = nextAttemptAt;
        j.lastErrorCode = errorCode;
      }
    }
  }
  async markJobsFailed(ids: number[], errorCode: string) {
    for (const j of this.jobs) {
      if (ids.includes(j.id)) {
        j.status = 'failed';
        j.attempts += 1;
        j.lastErrorCode = errorCode;
      }
    }
  }
  async jobsForEvent(eventId: string) {
    return this.jobs.filter((j) => j.eventId === eventId);
  }
  async countPendingJobs() {
    return this.jobs.filter((j) => j.status === 'pending').length;
  }
  async listMappings() {
    return this.mappings;
  }
  async getSettings() {
    return this.settings;
  }
  async listCameras() {
    return [...this.cameras.values()];
  }
  async upsertCameras(cameras: { uuid: string; name: string; location: string | null }[]) {
    const seen = new Set(cameras.map((c) => c.uuid));
    for (const c of cameras) this.cameras.set(c.uuid, { ...c, missing: false });
    for (const c of this.cameras.values()) if (!seen.has(c.uuid)) c.missing = true;
  }
  async replaceInventory(items: InventoryItem[]) {
    this.inventory = items;
  }
  async audit(entry: unknown) {
    this.auditLog.push(entry);
  }
}
