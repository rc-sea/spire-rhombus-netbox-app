# spire-rhombus-netbox-app

The bridge between the Spire Condominium's on-prem LenelS2 NetBox access control system and its Rhombus cloud video platform, plus the parking lobby displays.

**Status:** specification phase. No application code yet. The spec lives in [`openspec/`](openspec/) and is managed with [OpenSpec](https://github.com/Fission-AI/OpenSpec).

## What it will do

- **Collector** (Docker container on the building LAN): subscribes to NetBox activity, reconciles gaps, and pushes normalized events outbound to the cloud. Read-only toward NetBox; NetBox is never exposed.
- **Cloud service** (Vercel + Supabase, TypeScript): maps NetBox readers/portals/elevators to Rhombus cameras and publishes each event as a marker on the camera timeline; admin UI for mapping, settings and audit; health states and alerts.
- **Parking lobby displays**: kiosk pages showing live Rhombus views and static notices, using short-lived server-minted tokens.

See [`docs/spire-context.md`](docs/spire-context.md) for the building context, [`docs/netbox-nbapi.md`](docs/netbox-nbapi.md) and [`docs/rhombus-api.md`](docs/rhombus-api.md) for the API summaries, and [`docs/environment.md`](docs/environment.md) for what still needs to be obtained from vendors.

## The spec

```
openspec/
  config.yaml                                  project constraints applied to every artifact
  changes/build-netbox-rhombus-bridge/
    proposal.md                                why, what, scope, capabilities
    design.md                                  architecture and the decisions behind it
    tasks.md                                   implementation plan, grouped and verifiable
    specs/
      netbox-event-collection/spec.md
      rhombus-event-publishing/spec.md
      camera-mapping-admin/spec.md
      bridge-health-alerting/spec.md
      parking-lobby-display/spec.md
```

Useful commands (Node 22+):

```bash
npx @fission-ai/openspec@latest validate build-netbox-rhombus-bridge --strict
npx @fission-ai/openspec@latest show build-netbox-rhombus-bridge
npx @fission-ai/openspec@latest view
```

In Claude Code, `/opsx:apply build-netbox-rhombus-bridge` starts implementation from `tasks.md`; `/opsx:archive` folds the delta specs into `openspec/specs/` when the change ships.

## Non-negotiables

- Never write to NetBox.
- Never put a Rhombus API key or NetBox credential in a browser, a log, or the repo.
- No inbound ports on the building network.
