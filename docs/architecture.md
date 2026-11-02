# Architecture

Two deployables, one shared schema, and a hard trust boundary at the building's edge. Decisions and alternatives are in [`openspec/changes/build-netbox-rhombus-bridge/design.md`](../openspec/changes/build-netbox-rhombus-bridge/design.md); the behaviour each piece must have is in the specs beside it.

```
 Building LAN (no inbound ports)                 Cloud
 ┌──────────────────────────────────┐            ┌───────────────────────────────────────┐
 │  LenelS2 NetBox  <── NBAPI ──    │            │  cloud/  Next.js on Vercel             │
 │  (appliance)      read-only      │            │   ├─ /api/ingest/*  ◄── HTTPS, bearer  │
 │                        │         │            │   ├─ mapping + publish queue (Supabase) │
 │  collector/  (Docker)  │         │  outbound  │   ├─ publisher ── Rhombus API ──► cameras│
 │   ├─ NBAPI client ─────┘         │ ─ HTTPS ─► │   ├─ admin UI, health, alerts          │
 │   ├─ normalize (packages/shared) │            │   └─ display pages ── federated tokens │
 │   ├─ SQLite spool (node:sqlite)  │            └───────────────────────────────────────┘
 │   └─ heartbeat / inventory       │                         ▲
 └──────────────────────────────────┘            Parking lobby PCs (kiosk browser) ───┘
```

## Data flow

1. The collector logs in to NetBox with a dedicated read-only API user and holds the single `StreamEvents` connection. Each activity record is normalized into a `BridgeEvent` (`packages/shared`), given an idempotency id, and written to the local SQLite spool.
2. After any reconnect and every five minutes, `GetAccessHistory AFTERLOGID` fills gaps the stream cannot replay. Those events carry `source: "history"` and reuse the same id scheme, so the cloud discards duplicates.
3. The spool drains to `/api/ingest/events` in batches of up to 100 over HTTPS with a per-collector bearer secret. Acknowledged ids are removed from the spool. A heartbeat goes to `/api/ingest/heartbeat` every 60 s and brings back any actions (for example `refresh-inventory`), so the cloud never needs to reach the collector.
4. The cloud stores each event once, resolves its target cameras from the mapping table, and enqueues a publish job per camera. The publisher (immediate attempt plus a per-minute cron) calls `POST /api/camera/createCustomFootageSeekpoints` on Rhombus, batched per camera, with the event's original timestamp.
5. The admin UI edits mappings, settings, displays and alert recipients, with every change audited. The health evaluator turns heartbeats and job states into named health states and notifications.
6. Display pages fetch their layout with a per-display device token and play live video through the Rhombus React SDK using short-lived federated session tokens minted by the cloud. The Rhombus API key never leaves the server.

## Trust boundaries

| Boundary                  | What crosses it                 | Protection                                                                                                |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| NetBox ↔ collector        | NBAPI XML over the LAN          | Dedicated read-only NetBox user; command allow-list enforced in the client; credentials in Docker secrets |
| collector → cloud         | Events, heartbeats, inventory   | HTTPS, per-collector bearer secret (hashed at rest), zod validation, idempotent ids                       |
| cloud → Rhombus           | Seekpoints, camera list, tokens | Least-privilege API key in Vercel env; never logged or returned                                           |
| cloud → browser (admin)   | Mapping, events, health         | Supabase Auth, viewer/admin roles, RLS, 12 h idle expiry                                                  |
| cloud → browser (display) | Layout, federated tokens        | Per-display revocable device token; tokens scoped to that display's cameras                               |

## Repository layout

```
packages/shared/   zod schemas: BridgeEvent, Heartbeat, InventorySnapshot, NetBox time helpers
collector/         NBAPI client, stream + history, spool, delivery, heartbeat; Dockerfile
cloud/             Next.js app: ingest, mapping, publisher, admin UI, health, displays
docs/              building context, API summaries, environment checklist, this file
openspec/          proposal, design, specs and tasks for the current change
```

## Runtime

Node 26 everywhere (pinned in `.nvmrc`, `engines`, and the collector's Docker base image). pnpm workspaces. Biome for lint and format, Vitest for tests, GitHub Actions for CI.
