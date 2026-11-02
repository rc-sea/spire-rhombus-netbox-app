# Cloud service API

Base URL: the Vercel deployment (e.g. `https://spire-bridge.vercel.app`). All bodies are JSON.

## Collector endpoints

Authentication: `Authorization: Bearer <collectorId>.<secret>`. The secret is generated once (see "Creating a collector") and only its SHA-256 is stored. Wrong or missing credentials → `401`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/ingest/events` | `IngestRequest` (`@spire/shared`): `{ schemaVersion: 1, events: BridgeEvent[1..100] }` | `{ accepted: string[], rejected: { id, error }[] }` — accepted includes ids already stored (idempotent); the collector removes both accepted and rejected from its spool |
| POST | `/api/ingest/heartbeat` | `Heartbeat` | `{ actions: ("refresh-inventory")[] }` |
| POST | `/api/ingest/inventory` | `InventorySnapshot` | `{ ok: true, items: n }` |

Events whose `collectorId` differs from the credential are rejected per event. Events of kind `netbox-health` or `other`, or of a kind not in `settings.publish_kinds`, are stored with status `ignored`. Events with no mapping are stored as `unmapped` (or routed to the catch-all camera when that policy is on).

## Cron (Vercel)

`Authorization: Bearer $CRON_SECRET`. Configured in `vercel.json`.

| Path | Schedule | Does |
| --- | --- | --- |
| `GET /api/cron/publish` | every minute | drains up to 500 due publish jobs to Rhombus, one call per camera; returns `{ considered, published, retried, failed, cameras }` |
| `GET /api/cron/health` | every minute | health evaluation (group 6; stub today) |

## Monitoring

`GET /api/health` with `Authorization: Bearer $HEALTH_TOKEN` (or `?token=`). `200 { ok: true }` when no health state is raised, `503 { ok: false, raised: [...] }` otherwise.

## Admin (signed-in users, Supabase Auth cookie; role from `profiles`)

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/api/events?from&to&kind&reader&person&status&limit` | viewer | newest first, max 1000; `reader`/`person` are substring matches |

## Creating a collector

Until the admin UI ships (group 5), insert the row by hand in the Supabase SQL editor. Choose a long random secret (e.g. `openssl rand -base64 32`), then:

```sql
insert into public.collectors (id, name, secret_hash)
values ('spire-collector-1', 'Spire LAN collector', encode(digest('THE-SECRET', 'sha256'), 'hex'));
```

The collector's `CLOUD_SECRET` is then `spire-collector-1.THE-SECRET` (id, dot, secret).

## Local verification

```bash
curl -s -X POST "$BASE/api/ingest/heartbeat" -H "authorization: Bearer spire-collector-1.THE-SECRET" \
  -H 'content-type: application/json' -d '{"schemaVersion":1,"collectorId":"spire-collector-1","collectorVersion":"test","sentAt":"2026-11-02T20:00:00.000Z","netboxStatus":"connected","nbapiVersionConfigured":2,"nbapiVersionReported":"4.7 (legacy)","lastEventAt":null,"lastReconcileAt":null,"lastReconcileResult":null,"spoolSize":0,"cloudStatus":"ok","hostUptimeSec":1}'
# → {"actions":[]}
curl -s "$BASE/api/cron/publish" -H "authorization: Bearer $CRON_SECRET"
# → {"considered":0,"published":0,"retried":0,"failed":0,"cameras":0}
```
