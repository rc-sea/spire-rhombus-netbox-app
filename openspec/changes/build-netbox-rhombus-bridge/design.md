# Design

## Context

See proposal.md for motivation. The facts that shape the design:

- **NetBox** is an on-prem appliance (Ubuntu, single Ethernet port) on the building LAN. Its API (NBAPI) is XML over HTTP POST: commands at `/goforms/nbapi`, event list/trigger at `/appd/nbapi`, and a long-lived event stream at `/appdevent/nbapi/event`. Authentication is `Login` → session ID (a hash since 5.4) carried on each request; an alternative SHA-1 MAC scheme exists but needs a shared 8-character secret and a monotonic sequence number, which is fragile across restarts, so we use user-login auth. The stream delivers only events after subscription, sends a keep-alive every 10 s, and allows **one** stream client. `GetAccessHistory` supports `AFTERLOGID` for forward catch-up. Spire is on NBAPI v1 until Sequoyah applies the NetBox 6.2+ update (which removes v1 and enables v2); the April 2024 guide (API-UG-22) documents the command set we rely on.
- **Rhombus** is a cloud API at `https://api2.rhombussystems.com`, JSON over POST, authenticated with `x-auth-scheme: api-token` + `x-auth-apikey`. The ingest primitive is `/api/camera/createCustomFootageSeekpoints` (array of `{name ≤32, timestampMs, color, description ≤100, displayOverlay}` per camera). Browser video uses federated session tokens from `/api/org/generateFederatedSessionToken` and media URIs from `/api/camera/getMediaUris`; Rhombus publishes `@rhombussystems/react` (React 18+, DASH/WebSocket players), a Go CLI, a Python examples repo, and a TypeScript MCP server whose source is a useful reference for request shapes. There is no official Node SDK for the REST API.
- **Operators** are the property manager and board members. Sequoyah (LenelS2 integrator) owns NetBox configuration; the Rhombus dealer owns Rhombus licensing.
- **House stack** is Nuxt / Supabase / Vercel (TypeScript); this project deliberately uses Next.js (React) instead — see Decision 3.

## Goals / Non-Goals

**Goals:**
- NetBox never exposed; one outbound-only LAN container.
- At-least-once delivery NetBox → Rhombus with idempotency end to end; no silent loss, no duplicates on the timeline.
- Survive the NBAPI v1 → v2 switch with a config change.
- Property-manager-operable: mapping, displays and alerts configured in a UI, not files.
- Parking displays shippable before the NetBox update (they only need Rhombus).

**Non-Goals:**
- Any write path to NetBox; any door or elevator control.
- Replacing Rhombus's eventual native NetBox integration. If Rhombus ships it, the collector/publisher can be retired and the admin UI, health and displays remain useful.
- Multi-building or multi-tenant support (single site, single org).

## Decisions

### 1. Two deployables: on-prem collector + cloud bridge service

**Choice:** `collector` (Docker on a LAN host) + `cloud` (Vercel + Supabase).
**Why:** NetBox must not be internet-reachable, and Vercel functions cannot hold a long-lived HTTP stream to a LAN host. The collector is the only component that knows NetBox; the cloud holds config, mapping, Rhombus credentials, UI and alerting.
**Alternatives:** (a) everything on-prem — simpler but no cloud UI and the single box is a single point of operational knowledge; (b) tunnel/VPN from cloud to NetBox — moves complexity into networking the HOA does not control and still needs a persistent stream holder. Chosen split keeps the LAN footprint minimal (one container, outbound 443 only).

### 2. Collector language and shape

**Choice:** Node 22 + TypeScript, single process, `undici` for HTTP, `fast-xml-parser` for NBAPI XML, SQLite (`better-sqlite3`) for the local spool and `lastLogId`, Pino logs. Shipped as a multi-arch Docker image (amd64/arm64) with `restart: unless-stopped`.
**Why:** Same language as the cloud side so the shared event schema (`packages/shared`, zod) is literally shared; SQLite gives durable at-least-once without another service; Node handles one long-lived stream and periodic polling trivially.
**Alternatives:** Go (great for a daemon, but splits the codebase); Python (Rhombus examples exist, but no shared types). The NBAPI client is its own module with a **command allow-list** so the read-only guarantee is enforced in code, not by convention.

### 3. Cloud framework: Next.js (React) for the whole cloud app

**Choice:** Next.js (App Router) on Vercel for the admin UI, the API (Route Handlers), Vercel Cron jobs and the display pages. Display tiles use the official `@rhombussystems/react` `RhombusPlayer` directly (client components; the SDK is client-only), with `apiOverrideBaseUrl` pointed at our own token/media proxy routes. Supabase for Auth and Postgres as planned. Decided with RC on 2026-11-02.
**Why:** The one risky UI component is the unattended live-video tile; the Rhombus-maintained React SDK already handles reconnect, token refresh via a backend-minted federated token, live/playback switching and offline states, and tracks Rhombus's streaming changes. Everything else is CRUD and API routes, where Next.js and Nuxt are equivalent on Vercel. One framework keeps the bundle, debugging and mental model simple.
**Alternatives:** Nuxt 3 (house stack) with a React island for the player — keeps team familiarity but ships two frameworks and two reactivity systems in one page for a leaf component; Nuxt + Vue + `dash.js` per Rhombus's `player-example` (federated token → `getMediaUris` → DASH) — fully in-house, but we would own reconnect and token-refresh edge cases on a page nobody watches. Rejected in favour of the maintained SDK.

### 4. Transport collector → cloud

**Choice:** HTTPS POST to `/api/ingest/events` (batches ≤100, JSON, zod-validated) and `/api/ingest/heartbeat`, authenticated with a per-collector bearer secret (32-byte random, stored hashed in Supabase). Cloud → collector requests (inventory refresh) are **pulled** by the collector on each heartbeat response (`actions: ["refresh-inventory"]`), so the collector never listens.
**Why:** Outbound-only from the LAN; no WebSocket needed because latency of a few seconds is fine; heartbeat-piggybacked commands avoid any inbound path.
**Alternatives:** Supabase Realtime channel (adds a dependency and a persistent socket for little gain); message queue (overkill for tens of events per hour).

### 5. Ingest → publish pipeline on Vercel

**Choice:** Ingest route stores events and enqueues publish jobs in a Postgres table (`publish_jobs`, status machine pending → published | failed). A Vercel Cron (every minute) plus an immediate best-effort publish call after ingest drains the queue, grouping by camera and calling `createCustomFootageSeekpoints` once per camera. Backoff state is stored on the job.
**Why:** Vercel functions are short-lived; a DB-backed queue makes retries durable and visible in the UI. The immediate attempt keeps normal latency under 10 s; the cron guarantees drain after failures.
**Alternatives:** Supabase Edge Functions + pg_cron (possible, splits logic between two runtimes); an always-on worker on AWS (more infrastructure for a small queue). If volume ever exceeds what cron-per-minute handles, move the publisher to a small container next to the collector.

### 6. Data model (Supabase Postgres)

- `events` — id (idempotency key = `${netboxSerial}:${activityId|logId}:${source}`), occurred_at, received_at, kind, source, netbox jsonb, status, mapped_camera_uuids[].
- `publish_jobs` — event_id, camera_uuid, status, attempts, next_attempt_at, last_error_code.
- `netbox_inventory` — type (reader|portal|elevator|event), netbox_key, name, raw jsonb, seen_at.
- `rhombus_cameras` — uuid, name, location, seen_at.
- `mappings` — source_type, source_key, source_name_snapshot, camera_uuid, enabled, overlay, color_override.
- `settings` — singleton jsonb (default for unmapped, quiet hours, recipients, etc.).
- `collectors` — id, name, secret_hash, last_heartbeat jsonb, last_seen_at.
- `displays` — id, name, layout jsonb, device_token_hash, last_checkin_at, last_error.
- `health_states` — state, raised_at, cleared_at, last_notified_at, context jsonb.
- `audit_log` — actor, action, object_type, object_id, before, after, at.
Row-level security: admin UI uses Supabase Auth; service routes use the service-role key server-side only.

### 7. Identity of the person on the timeline

**Choice:** Seekpoint `name` = `<kind label> · <reader short name>` (≤32), `description` = `<person name> — <detail>` (≤100). PERSONID is stored in `events` but not sent to Rhombus. Person names are what the property manager already sees in NetBox; no photos or credential numbers leave NetBox.
**Why:** Keeps PII in Rhombus to what an operator needs to find footage; avoids pushing credential data to a second system.

### 8. Time handling

**Choice:** Collector requests `dateformat="tzoffset"` so NetBox returns GMT-offset timestamps; stream `CDT`/`NDT` values are parsed with the configured site timezone (`America/Los_Angeles`) as fallback. `timestampMs` sent to Rhombus is always UTC epoch ms from `occurredAt`.
**Why:** NetBox returns local time by default; a wrong offset puts markers hours off on the timeline.

### 9. Secrets and roles

- NetBox: dedicated user with a custom role granting API privileges and read-only access (Sequoyah creates it); password only in the collector's Docker secret.
- Rhombus: API key with a custom role limited to camera read, seekpoint create, media-URI read and federated-token generation; stored in Vercel env; rotated via admin UI setting (write-only field).
- Collector bearer secret: generated in admin UI, shown once, stored hashed.
- Display device tokens: per display, revocable, scoped by token → display id.
- Federated session tokens: minted per request for the display's cameras only; TTL per Rhombus default; refreshed by the page before expiry.

### 10. Observability

Pino JSON logs in both deployables; Vercel log drain optional. Health states computed by a per-minute cron from heartbeats and job tables (see spec). Email via Resend (or Supabase SMTP); Slack via incoming webhook. `/api/health` for an external uptime monitor (e.g. UptimeRobot) so the bridge is watched from outside its own platform.

## Risks / Trade-offs

- [NBAPI v1 behaviour differs subtly from the v2 guide] → Build against v1 on Spire's current NetBox first, keep the NBAPI client behind one interface, add a contract test suite that runs against a recorded fixture set for each version; re-run on the day of the NetBox update.
- [Only one `StreamEvents` client allowed] → If Sequoyah or braXos ever opens a stream, the collector's connection may fail; detect via "stream-down" state and document that the collector owns the stream. Reconciliation via `GetAccessHistory` ensures access events still arrive even with the stream down (door forced/held events do not appear in access history, so stream health matters).
- [Clock skew between NetBox, collector and Rhombus] → Use NetBox-provided tzoffset timestamps; monitor skew between NetBox `CDT` and collector receive time and surface it on the health page.
- [Vercel function limits during a large catch-up (thousands of events)] → Cron drains in bounded pages (≤500 jobs per run); the collector throttles history delivery to 100 events per batch, 1 batch/second.
- [Rhombus seekpoint limits or rate limits are undocumented] → Batch per camera, honour 429 with backoff, and ask the Rhombus dealer for limits; make the per-kind publish toggle available so noisy kinds (e.g. "Event normal") can be excluded.
- [`@rhombussystems/react` has a gap for kiosk use (e.g. no hook for a per-tile offline placeholder or a breaking release)] → Pin the SDK version; wrap `RhombusPlayer` in our own tile component that owns the placeholder, check-in and reload logic; fallback is `dash.js` per Rhombus's `player-example` (federated token → `getMediaUris` → DASH), documented in docs/rhombus-api.md.
- [Team is Nuxt-first] → Next.js is close enough for an app this size; keep the admin UI to a small set of pages, and lean on Supabase for auth and data access patterns the team already knows.
- [Display PCs are old Magic Monitor machines] → Verify Chrome/Edge version and H.264/WebCodecs support in task 1; fallback static panel is specified.
- [Rhombus ships native NetBox integration mid-project] → Collector/publisher become redundant; displays, admin and health keep value. Keep the publisher behind a feature flag so it can be turned off without redeploying.

## Migration Plan

1. Deploy cloud service with no collector; configure Rhombus key; verify camera inventory and a manual test seekpoint.
2. Ship parking lobby display (needs only Rhombus) — early, visible win.
3. Sequoyah enables NBAPI (Data Integration tab), creates the read-only API user, and confirms the NetBox IP and HTTP/HTTPS. Collector deployed on the LAN host against NBAPI v1; verify stream and history; verify first real seekpoints.
4. Property manager completes mappings in the admin UI; alerts configured.
5. On the NetBox 6.2+ update day: switch `NBAPI_VERSION=2`, run contract tests, confirm `GetAPIVersion`, confirm events flow.
Rollback at any step: stop the collector container (no NetBox state is changed by the bridge); disable publishing via feature flag; displays are independent.

## Open Questions

- HTTP vs HTTPS for NBAPI on Spire's NetBox, and whether its certificate is self-signed (affects collector CA config only).
- Exact NBAPI `GetElevators`/`GetFloors` response shapes on Spire's firmware (used for elevator mapping; readers/portals suffice for v1 if they differ).
- Rhombus federated token TTL and whether `getMediaUris` requires the token to be scoped per camera (affects refresh cadence only).
- Which LAN host: a dedicated mini PC (recommended, ~$300) versus a VM on the braXos replacement server (only with braXos's written agreement).
- Whether the Rhombus dealer's plan includes API access and the number of cameras per display tile that Rhombus licensing allows for continuous live viewing.
