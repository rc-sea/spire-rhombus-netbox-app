# Proposal: NetBox ↔ Rhombus bridge for the Spire Condominium

## Why

Spire's access control (LenelS2 NetBox, on-prem) and its video platform (Rhombus, cloud) are not connected: a fob read, a forced door, an elevator call or a ButterflyMX visitor release leaves no mark on any camera timeline, so every incident means scrubbing footage by hand. Rhombus has shipped LenelS2 integrations for Elements (June 2026) and OnGuard (August 2026) but not for NetBox, and Sequoyah has confirmed that pulling Rhombus video *into* NetBox is both unnecessary and expensive (third-party video licensing plus a per-camera fee; the old camera server licence alone was about $5,500/yr). Pushing NetBox events *out* to Rhombus carries no NetBox licensing and makes Rhombus the single place to look after an incident.

A second, time-sensitive gap rides along: the parking lobby displays went dark when the old NetVR/VRx camera server died. Sequoyah's view is that a Rhombus-based display needs no Sequoyah involvement. Because the bridge already has to mint browser-safe Rhombus session tokens, a kiosk page that shows live Rhombus views plus static text is a small addition with a large, visible payoff for residents.

## What Changes

- New on-prem **collector** service (Docker, building LAN) that subscribes to the NetBox activity stream (NBAPI `StreamEvents`), reconciles gaps from `GetAccessHistory`, and forwards normalized access events outbound over HTTPS to the cloud service. NetBox is never exposed to the internet.
- New cloud **bridge service** (Vercel + Supabase, TypeScript) that receives collector events, maps NetBox readers/portals/elevators to Rhombus cameras, and publishes each event as a custom footage seekpoint on the mapped camera(s) via `/api/camera/createCustomFootageSeekpoints`.
- New **admin UI** (property-manager friendly) for maintaining the reader-to-camera mapping, viewing recent bridged events, and seeing collector/Rhombus health, with an audit log of changes.
- New **health monitoring and alerting**: heartbeat from the collector, detection of stream drops, Rhombus rejections and "no events for N minutes", with email (and optionally Slack) notifications.
- New **parking lobby display** page: a kiosk-mode web page per display that shows one or more live Rhombus camera views plus configurable static text/images, authenticated with short-lived federated session tokens minted server-side (no API key in the browser).
- Repository scaffolding: monorepo with `collector/` and `cloud/` packages, shared event schema, CI, and docs.

Out of scope for v1 (explicitly):
- Writing anything to NetBox (people, credentials, access levels, portals, outputs, events). The bridge is read-only toward NetBox.
- Streaming Rhombus video into NetBox or Magic Monitor. Sequoyah has confirmed this is not needed; licensing makes it unattractive.
- Replacing braXos, ButterflyMX–braXos visitor floor grants, or any elevator logic. braXos remains the Otis Compass head-end.
- Parkworks garage signage. Sequoyah confirmed it is hard-wired (Parkworks outputs → NetBox inputs); no API is involved.
- Rhombus Access Control hardware, door unlock from the bridge, or two-way control of any kind.
- Face/person identity matching in Rhombus beyond what the seekpoint name/description carries.

## Capabilities

### New Capabilities

- `netbox-event-collection`: Subscribing to NetBox activity in real time, recovering missed activity after disconnects, normalizing events into a stable bridge schema, and delivering them to the cloud service reliably (at-least-once, idempotent) from inside the building network.
- `rhombus-event-publishing`: Turning bridged events into Rhombus footage seekpoints on the correct camera(s) with correct timestamps, names, colours and descriptions; de-duplicating; handling Rhombus rate limits and errors; retaining a queryable event log.
- `camera-mapping-admin`: Authenticated admin web UI and API for maintaining the mapping between NetBox sources (readers, portals, elevators, event names) and Rhombus cameras, with validation against live NetBox and Rhombus inventories and an audit trail.
- `bridge-health-alerting`: Heartbeats, health states, and notifications for collector connectivity, NetBox stream status, Rhombus publishing failures, and event silence; a health page and a machine-readable health endpoint.
- `parking-lobby-display`: Kiosk web pages for the parking lobby PCs that render live Rhombus camera views and static content, using short-lived server-minted tokens, resilient to network blips and unattended for weeks.

### Modified Capabilities

(none — greenfield project)

## Impact

- **New repository code**: `collector/` (Node 26 + TypeScript, Docker image), `cloud/` (Next.js on Vercel with Supabase Auth and Postgres — see design.md Decision 3), `packages/shared/` (event schema, zod validators).
- **External systems touched**: NetBox (read-only NBAPI user with API privileges; Data Integration enabled by Sequoyah), Rhombus (API key with a least-privilege role; federated session tokens for displays), email/Slack for alerts.
- **Building network**: one LAN host (small PC or NUC, or a VM on the braXos replacement server only if braXos agrees in writing) running Docker, with outbound HTTPS to Vercel and Rhombus only. No inbound rules.
- **Vendors**: Sequoyah must enable NBAPI and create the API user; Rhombus dealer must confirm API access on Spire's plan and camera UUIDs; ButterflyMX is untouched (its releases appear as NetBox portal events).
- **Dependencies on the wider plan**: NBAPI v1 until the NetBox 6.2+ update, v2 after; the collector must survive that switch with a config change only. The display replaces a dead Magic Monitor feed and can ship before the NetBox update.
