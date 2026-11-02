/**
 * Storage interface for the bridge. Logic modules (ingest, mapping, publisher)
 * depend only on this; `supabase-repo.ts` implements it for production and
 * `test/memory-repo.ts` for tests.
 */
import type { BridgeEvent, Heartbeat, InventoryItem } from '@spire/shared';

export type EventStatus = 'pending' | 'published' | 'partial' | 'failed' | 'unmapped' | 'ignored';
export type JobStatus = 'pending' | 'published' | 'failed';
export type SeekpointColor = 'BLUE' | 'RED' | 'PURPLE' | 'TAN' | 'ORANGE' | 'TEAL' | 'GRAY' | 'BLACK';

export interface CollectorRow {
  id: string;
  name: string;
  secretHash: string;
  lastSeenAt: string | null;
  lastHeartbeat: Heartbeat | null;
}

export interface EventRow {
  id: string;
  collectorId: string;
  source: BridgeEvent['source'];
  kind: BridgeEvent['kind'];
  occurredAt: string;
  receivedAt: string;
  ingestedAt: string;
  netbox: BridgeEvent['netbox'];
  status: EventStatus;
  targetCameras: string[];
}

export interface PublishJob {
  id: number;
  eventId: string;
  cameraUuid: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  publishedAt: string | null;
}

export interface Mapping {
  id: number;
  sourceType: 'reader' | 'portal' | 'elevator' | 'event';
  sourceKey: string;
  sourceNameSnapshot: string;
  cameraUuid: string;
  enabled: boolean;
  overlay: boolean | null;
  colorOverride: SeekpointColor | null;
}

export interface Settings {
  unmappedPolicy: 'ignore' | 'catch-all';
  catchAllCamera: string | null;
  publishKinds: string[];
  overlayKinds: string[];
  quietHours: { start: string; end: string; days: number[] };
  eventSilenceHours: number;
  alertRecipients: string[];
  slackWebhook: string | null;
}

export interface CameraRow {
  uuid: string;
  name: string;
  location: string | null;
  missing: boolean;
}

export interface EventQuery {
  from?: string;
  to?: string;
  kind?: string;
  reader?: string;
  person?: string;
  status?: EventStatus;
  limit?: number;
}

export interface Repo {
  // collectors
  getCollector(id: string): Promise<CollectorRow | null>;
  touchCollector(id: string, heartbeat: Heartbeat): Promise<void>;

  // events
  /** Insert events that are not yet stored; returns the ids actually inserted. */
  insertEvents(events: BridgeEvent[]): Promise<string[]>;
  getEvent(id: string): Promise<EventRow | null>;
  setEventTargets(id: string, cameras: string[], status: EventStatus): Promise<void>;
  updateEventStatus(id: string, status: EventStatus): Promise<void>;
  queryEvents(q: EventQuery): Promise<EventRow[]>;

  // jobs
  enqueueJobs(jobs: { eventId: string; cameraUuid: string }[]): Promise<void>;
  /** Pending jobs whose next_attempt_at <= now, oldest first. */
  dueJobs(limit: number, now: string): Promise<PublishJob[]>;
  markJobsPublished(ids: number[], at: string): Promise<void>;
  markJobsRetry(ids: number[], nextAttemptAt: string, errorCode: string): Promise<void>;
  markJobsFailed(ids: number[], errorCode: string): Promise<void>;
  jobsForEvent(eventId: string): Promise<PublishJob[]>;
  countPendingJobs(): Promise<number>;

  // mapping + settings + cameras + inventory
  listMappings(): Promise<Mapping[]>;
  getSettings(): Promise<Settings>;
  listCameras(): Promise<CameraRow[]>;
  upsertCameras(cameras: { uuid: string; name: string; location: string | null }[]): Promise<void>;
  replaceInventory(items: InventoryItem[], seenAt: string): Promise<void>;

  // audit
  audit(entry: { actor: string; action: string; objectType: string; objectId?: string; before?: unknown; after?: unknown }): Promise<void>;
}
