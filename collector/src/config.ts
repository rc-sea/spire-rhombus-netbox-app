/**
 * Collector configuration from environment variables. Secrets may be given
 * directly (NETBOX_PASSWORD) or as a file path (NETBOX_PASSWORD_FILE) for
 * Docker secrets. Nothing here is logged with its value.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Env = z.object({
  COLLECTOR_ID: z.string().min(1).default('spire-collector-1'),
  COLLECTOR_VERSION: z.string().default('0.1.0'),

  NETBOX_BASE_URL: z.string().url(),
  NETBOX_USERNAME: z.string().min(1),
  NETBOX_PASSWORD: z.string().optional(),
  NETBOX_PASSWORD_FILE: z.string().optional(),
  /** 1, 2 or auto (default). */
  NBAPI_VERSION: z.enum(['1', '2', 'auto']).default('auto'),
  /** legacy, nbws or auto (default). */
  NBAPI_PATH_FAMILY: z.enum(['legacy', 'nbws', 'auto']).default('auto'),
  NBAPI_BODY_MODE: z.enum(['raw', 'form']).default('raw'),
  NBAPI_SESSION_COOKIE: z.enum(['true', 'false']).default('true'),
  /** Accept a self-signed NetBox certificate (HTTPS only). Prefer NETBOX_CA_FILE. */
  NETBOX_TLS_INSECURE: z.enum(['true', 'false']).default('false'),
  NETBOX_CA_FILE: z.string().optional(),
  /** Explicit path overrides, normally unset (the probe picks the family). */
  NBAPI_COMMANDS_PATH: z.string().optional(),
  NBAPI_EVENTS_PATH: z.string().optional(),
  NBAPI_STREAM_PATH: z.string().optional(),

  SITE_TIMEZONE: z.string().default('America/Los_Angeles'),

  CLOUD_BASE_URL: z.string().url(),
  CLOUD_SECRET: z.string().optional(),
  CLOUD_SECRET_FILE: z.string().optional(),

  SPOOL_PATH: z.string().default('/data/spool.sqlite'),
  SPOOL_MAX_EVENTS: z.coerce.number().int().positive().default(100_000),
  SPOOL_MAX_AGE_DAYS: z.coerce.number().positive().default(7),

  RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  INVENTORY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 3_600_000),
  STREAM_SILENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Localhost-only health endpoint port; 0 disables. */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface CollectorConfig {
  collectorId: string;
  collectorVersion: string;
  netbox: {
    baseUrl: string;
    username: string;
    password: string;
    version: 1 | 2 | 'auto';
    pathFamily: 'legacy' | 'nbws' | 'auto';
    bodyMode: 'raw' | 'form';
    sessionCookie: boolean;
    tlsInsecure: boolean;
    caFile: string | undefined;
    paths: { commands?: string; events?: string; stream?: string };
  };
  siteTimezone: string;
  cloud: { baseUrl: string; secret: string };
  spool: { path: string; maxEvents: number; maxAgeDays: number };
  intervals: {
    reconcileMs: number;
    heartbeatMs: number;
    inventoryMs: number;
    streamSilenceMs: number;
  };
  deliveryBatchSize: number;
  healthPort: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

function secret(direct: string | undefined, file: string | undefined, name: string): string {
  if (direct) return direct;
  if (file) return readFileSync(file, 'utf8').trim();
  throw new Error(`Missing ${name} (set ${name} or ${name}_FILE)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const e = Env.parse(env);
  return {
    collectorId: e.COLLECTOR_ID,
    collectorVersion: e.COLLECTOR_VERSION,
    netbox: {
      baseUrl: e.NETBOX_BASE_URL.replace(/\/+$/, ''),
      username: e.NETBOX_USERNAME,
      password: secret(e.NETBOX_PASSWORD, e.NETBOX_PASSWORD_FILE, 'NETBOX_PASSWORD'),
      version: e.NBAPI_VERSION === 'auto' ? 'auto' : (Number(e.NBAPI_VERSION) as 1 | 2),
      pathFamily: e.NBAPI_PATH_FAMILY,
      bodyMode: e.NBAPI_BODY_MODE,
      sessionCookie: e.NBAPI_SESSION_COOKIE === 'true',
      tlsInsecure: e.NETBOX_TLS_INSECURE === 'true',
      caFile: e.NETBOX_CA_FILE,
      paths: {
        ...(e.NBAPI_COMMANDS_PATH ? { commands: e.NBAPI_COMMANDS_PATH } : {}),
        ...(e.NBAPI_EVENTS_PATH ? { events: e.NBAPI_EVENTS_PATH } : {}),
        ...(e.NBAPI_STREAM_PATH ? { stream: e.NBAPI_STREAM_PATH } : {}),
      },
    },
    siteTimezone: e.SITE_TIMEZONE,
    cloud: {
      baseUrl: e.CLOUD_BASE_URL.replace(/\/+$/, ''),
      secret: secret(e.CLOUD_SECRET, e.CLOUD_SECRET_FILE, 'CLOUD_SECRET'),
    },
    spool: { path: e.SPOOL_PATH, maxEvents: e.SPOOL_MAX_EVENTS, maxAgeDays: e.SPOOL_MAX_AGE_DAYS },
    intervals: {
      reconcileMs: e.RECONCILE_INTERVAL_MS,
      heartbeatMs: e.HEARTBEAT_INTERVAL_MS,
      inventoryMs: e.INVENTORY_INTERVAL_MS,
      streamSilenceMs: e.STREAM_SILENCE_TIMEOUT_MS,
    },
    deliveryBatchSize: e.DELIVERY_BATCH_SIZE,
    healthPort: e.HEALTH_PORT,
    logLevel: e.LOG_LEVEL,
  };
}
