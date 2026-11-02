# Tasks

## 1. Repository and shared foundations

- [x] 1.1 Scaffold a pnpm monorepo with `collector/`, `cloud/`, `packages/shared/`; verify `pnpm -r build` and `pnpm -r test` run green on an empty test
- [x] 1.2 Define the bridge event schema in `packages/shared` with zod (`BridgeEvent`, `Heartbeat`, `InventorySnapshot`, `IngestResponse`) and verify unit tests cover every `kind` and reject unknown fields
- [x] 1.3 Add GitHub Actions CI (lint, typecheck, test, Docker build for collector) and verify a PR shows all checks passing
- [x] 1.4 Write `docs/architecture.md` (two deployables, data flow, trust boundaries) and verify it links to design.md and the API summaries in `docs/`
- [ ] 1.5 [vendor] Obtain from Sequoyah: NetBox IP, HTTP/HTTPS, NBAPI enabled on the Data Integration tab, read-only API user credentials, current NetBox version; record in `docs/environment.md` (no secrets) and verify `PingApp` succeeds from the LAN host
- [ ] 1.6 [vendor] Obtain from the Rhombus dealer: confirmation of API access, an API key role with camera read / seekpoint create / media URI / federated token permissions, and the camera list; verify `getMinimalCameraStateList` returns Spire's cameras

## 2. NBAPI client (collector)

- [x] 2.1 Implement the NBAPI XML client (`Login`, `Logout`, `PingApp`, `GetAPIVersion`, request/response envelope, `APIERROR` and `CODE` handling, `dateformat=tzoffset`) with a read-only command allow-list; verify unit tests show a disallowed command is refused without a request
- [x] 2.2 Implement `GetReaders`, `GetPortals`, `GetElevators`, `GetFloors`, `ListEvents` with pagination via `STARTFROMKEY`/`NEXTKEY`; verify fixture-based tests parse the April 2024 guide's example responses
- [x] 2.3 Implement `GetAccessHistory` with `AFTERLOGID`/`MAXRECORDS` and `NOT FOUND` handling; verify tests cover ascending catch-up and the -1 `NEXTLOGID` terminator
- [x] 2.4 Implement `StreamEvents` as an async iterator over the chunked HTTP response with TAGNAMES, keep-alive detection (30 s), single-connection guard and backoff; verify tests using a fake server that emits events, keep-alives and mid-stream disconnects
- [ ] 2.5 Record real responses from Spire's NetBox (secrets redacted) as fixtures for the current version and path family, verify the contract test suite passes against them, and verify `probe()` reports the expected family and `GetAPIVersion`; repeat after the NetBox update for v2/`/nbws` (and confirm the 6.x event-stream path)
- [ ] 2.5a [vendor] Obtain the NBAPI v2 guide (#API2-UG-8, April 2025) from the NetBox help portal via Sequoyah; diff the read-only commands we use against the v1 guide and record findings in docs/netbox-nbapi.md
- [ ] 2.5b [vendor] Ask Sequoyah whether Spire's firmware exposes "Enable V2" alongside v1 today; if so, run the collector on v2 now and record the outcome in docs/environment.md
- [x] 2.6 Document the client and the allow-list in `collector/README.md` and verify the documented example runs against the fake server

## 3. Collector service

- [x] 3.1 Implement event normalization (DESCNAME → `kind`, tzoffset/site-timezone parsing to UTC, idempotency key) and verify unit tests cover Access Granted, Invalid Access, Portal Forced/Held, Elevator Access Granted/Denied/Free Access, Event Activated/Normal and an unknown DESCNAME
- [x] 3.2 Implement the SQLite spool (bounded by 7 days / 100k events) and `lastLogId` persistence; verify tests show events survive a process restart and oldest-drop works at the bound
- [x] 3.3 Implement the cloud delivery loop (batches ≤100, bearer auth, backoff, 401/403 stop-and-hold, ack-based spool removal) and verify tests against a fake ingest server covering 2xx, 5xx, timeout and 401
- [x] 3.4 Implement the reconciliation job (after reconnect and every 5 min) using `GetAccessHistory AFTERLOGID` and verify an integration test shows a 14-event gap is delivered with `source: "history"` and duplicate ids are reused
- [x] 3.5 Implement heartbeat (60 s) with status fields and inventory-refresh action handling; verify tests show a `refresh-inventory` action triggers inventory publication within 60 s
- [ ] 3.6 (image builds on RC's Mac 2026-11-02; compose run on the LAN host still pending) Build the Docker image (multi-arch, non-root, no secrets, `restart: unless-stopped` compose file, localhost-only health endpoint) and verify `docker compose up` on a clean host starts, logs in, and streams against the fake NetBox server
- [x] 3.7 Write `collector/DEPLOY.md` (LAN host requirements, outbound-only firewall rule, secrets via Docker secrets, upgrade and rollback) and verify a reviewer can follow it to a running container

## 4. Cloud service: ingest and publishing

- [ ] 4.1 Create the Next.js (App Router) project on Vercel with Supabase (Auth + Postgres), migrations for the tables in design.md Decision 6, and RLS policies; verify migrations apply cleanly to a fresh project and RLS blocks anonymous reads
- [ ] 4.2 Implement `/api/ingest/events` (bearer auth against hashed collector secret, zod validation, idempotent insert, per-event errors) and verify tests cover new, duplicate, invalid-auth and partially invalid batches
- [ ] 4.3 Implement `/api/ingest/heartbeat` and `/api/ingest/inventory` and verify tests store heartbeats and upsert inventory by (type, netbox_key)
- [ ] 4.4 Implement the Rhombus client (`createCustomFootageSeekpoints`, `getMinimalCameraStateList`, `generateFederatedSessionToken`, `getMediaUris`) with error-code handling and 429 backoff; verify tests use recorded responses and assert the API key never appears in logs
- [ ] 4.5 Implement mapping resolution (reader → portal → elevator → event name → default) and the `publish_jobs` state machine with per-camera batching; verify tests cover two-camera fan-out, unmapped, disabled mapping and catch-all
- [ ] 4.6 Implement the publisher (immediate attempt after ingest + per-minute Vercel Cron drain, ≤500 jobs/run, backoff on job) and verify an integration test publishes a seekpoint at the event's `occurredAt` and marks the job published
- [ ] 4.7 Implement the event log query API and verify tests filter by time, kind, reader and status and return camera UUIDs and timestamps
- [ ] 4.8 Document the ingest and query APIs in `cloud/docs/api.md` and verify examples run with `curl` against a preview deployment

## 5. Admin UI: mapping, settings, audit

- [ ] 5.1 Implement sign-in (Supabase Auth magic link) with `viewer`/`admin` roles and 12 h idle expiry; verify tests show a viewer gets 403 on edits and anonymous requests are redirected
- [ ] 5.2 Build the mapping editor (NetBox sources from inventory, Rhombus cameras with refresh, multi-camera assignment, enable/overlay/colour options, "missing in NetBox/Rhombus" flags) and verify a manual test maps one reader to two cameras and events fan out
- [ ] 5.3 Implement settings (default for unmapped, quiet hours, recipients, Rhombus key as write-only field) and verify changes take effect for new events within 30 s without redeploy
- [ ] 5.4 Implement mapping export/import with dry-run diff and verify tests show no change is applied before confirmation
- [ ] 5.5 Implement the audit log (write on every mapping/setting/display change; filterable view) and verify tests assert before/after values are stored
- [ ] 5.6 Implement "Send test marker" and verify a "Bridge test" seekpoint appears in the Rhombus Console on the chosen camera
- [ ] 5.7 Write `docs/operator-guide.md` for the property manager (sign in, map a reader, test it, read the health page) and verify a non-engineer can follow it in a walkthrough

## 6. Health and alerting

- [ ] 6.1 Implement the per-minute health evaluator (collector-offline, netbox-stream-down, netbox-auth-failed, rhombus-failing, event-silence with quiet hours, backlog, display-offline) and verify unit tests cover raise, hold, and clear-after-two-checks for each state
- [ ] 6.2 Implement notifications (email via Resend; optional Slack webhook) with 6 h repeat limiting and recovery messages; verify tests show at most 4 notifications over a 24 h persisting state
- [ ] 6.3 Build the health page (states, last heartbeat, hourly/daily counts, last 20 errors, NetBox-reported items) and `/api/health` with static token returning 200/503; verify an external monitor receives 503 while a state is raised
- [ ] 6.4 Document alert meanings and first responses in `docs/runbook.md` and verify each state in the evaluator has a runbook entry

## 7. Parking lobby display

- [ ] 7.1 Verify the parking lobby PCs' browser (Chrome/Edge version, H.264/WebCodecs support, kiosk mode) and record findings in `docs/environment.md`; verify the Rhombus `player-example` plays one Spire camera on that hardware
- [ ] 7.2 Implement display configuration (layouts, tiles, text panel, rotation, device token issue/revoke) in the admin UI with audit; verify tests show a token for display A cannot fetch display B
- [ ] 7.3 Implement server-side federated token minting scoped to a display's cameras with refresh endpoint; verify tests assert the API key is absent from responses and the page bundle
- [ ] 7.4 Implement the display page (Next.js client route, a tile component wrapping `@rhombussystems/react` `RhombusPlayer` with `apiOverrideBaseUrl` pointed at our token/media proxy routes, SDK version pinned), config polling (60 s), offline placeholders, auto-reconnect, daily reload; verify a manual test survives a 2-minute network cut and a camera being disabled
- [ ] 7.5 Implement display check-in and `display-offline` health state; verify tests raise the state after 10 minutes without check-in during scheduled hours
- [ ] 7.6 Deploy to the first parking lobby PC in kiosk mode and verify it runs unattended for 72 hours; document the PC setup in `docs/display-setup.md`

## 8. Integration and cut-over

- [ ] 8.1 End-to-end test on Spire's NetBox (NBAPI v1): badge at a mapped reader and verify a seekpoint appears on the mapped camera within 10 s with the correct timestamp
- [ ] 8.2 Outage drill: stop the collector for 20 minutes, restart, and verify the gap is reconciled and no duplicates appear on the timeline
- [ ] 8.3 Alert drill: block outbound traffic from the LAN host and verify `collector-offline` is raised, notified once, and cleared on recovery
- [ ] 8.4 [vendor] On the NetBox 6.2+ update day, switch `NBAPI_VERSION=2`, run the contract suite, and verify stream, history and inventory all work; record results in `docs/environment.md`
- [ ] 8.5 Security review: confirm no inbound ports on the LAN host, secrets only in Docker secrets/Vercel env, RLS policies, token scoping; verify a checklist in `docs/security.md` is signed off

## Workflow follow-up

- Archive the change after the end-to-end test (8.1) and the 72-hour display soak (7.6) pass.
- Re-evaluate the collector and publisher if Rhombus ships a native NetBox integration; keep displays, admin and health regardless.
