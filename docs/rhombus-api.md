# Rhombus API — working summary

Sources: https://developer.rhombus.com/ (API reference, checked 2026-11-02), Rhombus GitHub org (https://github.com/RhombusSystems), Rhombus support articles.

## Basics

- Base URL (US): `https://api2.rhombussystems.com`. EU orgs use `api2.eu.rhombussystems.com`; keys are region-bound.
- Mostly `POST` with a JSON body. Auth headers: `x-auth-scheme: api-token` and `x-auth-apikey: <key>`. OAuth bearer and partner keys also exist. Some failures return HTTP 200 with `"error": true` — always check `error`/`errorCode`.
- Error codes to branch on: 400 `VALIDATION_FAILED`, `MISSING_REQUIRED_FIELD`, `FEATURE_NOT_ENABLED`; 401 `UNAUTHENTICATED`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED`; 403 `ROLE_NOT_PERMITTED`, `PERMISSION_REQUIRED`, `FUNCTIONALITY_REQUIRED`; 429 `RATE_LIMITED`; 5xx. Numeric rate limits are not published — honour 429 with backoff and ask the dealer.
- API keys are created in Console → Settings → Integrations & Developer Resources → API Tokens, with a role. Create a dedicated role for the bridge.
- Rhombus also offers outbound webhooks (alerts, door/sensor events) and a WebSocket event stream; not needed for v1 (we push into Rhombus, we don't consume from it).

## Endpoints we use

| Purpose | Endpoint |
| --- | --- |
| Create timeline markers (the core ingest) | `POST /api/camera/createCustomFootageSeekpoints` — body `{ cameraUuid, footageSeekPoints: [{ name ≤32, timestampMs, color?: BLUE|RED|PURPLE|TAN|ORANGE|TEAL|GRAY|BLACK, description ≤100, displayOverlay? }] }` |
| Read markers back (verification, dedupe checks) | `POST /api/camera/getCustomFootageSeekpointsV2` |
| Camera inventory | `POST /api/camera/getMinimalCameraStateList`; details via `getCameraDetails` |
| Locations | `POST /api/location/getLocations` |
| Browser video: short-lived token | `POST /api/org/generateFederatedSessionToken` (minted server-side; never ship the API key to a browser) |
| Browser video: stream URIs | `POST /api/camera/getMediaUris` |

Deprecated operations exist (83 hidden behind a toggle in the reference). Check each endpoint's deprecation status before use.

## SDKs and reference code

- `@rhombussystems/react` (npm, v2.x, React 18+): `RhombusPlayer` (live + playback, DASH/WebSocket), `RhombusBufferedPlayer` (MPEG-DASH on a native `<video>`), `RhombusRealtimePlayer` (low-latency H.264 over WebSocket to canvas; needs WebCodecs — Chrome/Edge/Safari 16.4+). Expects your backend to mint federated tokens (`POST /api/federated-token` by convention) and takes `apiOverrideBaseUrl` for a proxy. Client-only in SSR frameworks.
- `player-example` (GitHub): framework-free DashJS recipe — proxy mints federated token → `getMediaUris` → DashJS plays. The fallback if the React island in Nuxt is awkward.
- `rhombus-cli` (Go) and `rhombus-node-mcp` (TypeScript MCP server): useful as reference for request shapes; the MCP source already contains a read-only "netbox events" tool, a hint that Rhombus is building NetBox support.
- `api-examples-python` (GitHub): Python examples.
- There is no official Node REST SDK; we write a thin typed client.

## Integrations relevant to Spire

- Rhombus–ButterflyMX exists (markers per badge entry, 10-s clips, face-to-account) but is **not** set up at Spire and is not needed once NetBox feeds Rhombus, since ButterflyMX releases appear as NetBox portal events.
- Rhombus–LenelS2: Elements (June 2026) and OnGuard (Aug 2026, OAAP) shipped; NetBox "in progress", no date.
