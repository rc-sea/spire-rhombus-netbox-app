# collector

The on-prem half of the bridge: a single Node 26 process that reads LenelS2 NetBox activity over NBAPI and forwards it to the cloud service. It runs as a Docker container on the building LAN, makes outbound connections only, and never writes to NetBox.

## Status

| Piece | State |
| --- | --- |
| `src/nbapi/` — NBAPI client, typed commands, event stream | done, tested against a fake NetBox |
| `src/collector.ts` and friends — normalization, `node:sqlite` spool, delivery with backoff, reconciliation, heartbeat, inventory | done, end-to-end tested against fake NetBox + fake cloud |
| `Dockerfile`, `docker-compose.yml`, `DEPLOY.md` | written; image build verified in CI |

## Running it

Configuration is environment variables (see `.env.example` and `DEPLOY.md`). Locally:

```bash
NETBOX_BASE_URL=http://192.168.1.10 NETBOX_USERNAME=bridge-ro NETBOX_PASSWORD=… \
CLOUD_BASE_URL=https://spire-bridge.vercel.app CLOUD_SECRET=… \
SPOOL_PATH=./spool.sqlite pnpm --filter @spire/collector dev
```

On start the collector probes NetBox (path family + `GetAPIVersion`), opens the event stream, sets the access-history high-water mark, and begins heartbeating. Events go to the local spool first and are delivered to the cloud in batches with backoff; the spool survives restarts and holds up to 7 days / 100k events.

Idempotency: access events (granted/denied) are keyed by reader + person + second so the same fob read seen on the stream and in `GetAccessHistory` collapses to one id; all other activity is keyed by NetBox `ACTIVITYID`.

## The NBAPI client

```ts
import { NbapiClient, getReaders, getAccessHistory, EventStream, DEFAULT_STREAM_TAGS } from './src/nbapi/index.js';

const netbox = new NbapiClient({
  baseUrl: 'http://192.168.10.5',   // from Sequoyah; https:// if the unit has a certificate
  username: 'bridge-ro',             // dedicated read-only API user
  password: process.env.NETBOX_PASSWORD!,
  version: 1,                        // 2 after the NetBox 6.2+ update
});

const readers = await getReaders(netbox);
const page = await getAccessHistory(netbox, { afterLogId: '56957' });

const stream = new EventStream(netbox, { tags: DEFAULT_STREAM_TAGS, onStatus: (s, d) => console.log(s, d) });
for await (const ev of stream.events()) {
  console.log(ev.tags.DESCNAME, ev.tags.RDRNAME, ev.tags.CDT);
}
```

What the client guarantees:

- **Read-only.** `src/nbapi/types.ts` holds the allow-list (`Login`, `Logout`, `PingApp`, `GetAPIVersion`, `GetReaders`, `GetPortals`, `GetElevators`, `GetFloors`, `ListEvents`, `GetAccessHistory`, `GetEventHistory`, `StreamEvents`). Any other command name is refused by `NbapiClient.call` before a request is built, and refused again in the low-level sender. `test/client.test.ts` asserts that `AddPerson`, `UnlockPortal`, `TriggerEvent`, `SetThreatLevel` and friends never reach the wire.
- **Sessions.** Logs in lazily, carries the session id as the `sessionid` attribute and (for event endpoints) as a `.sessionid` cookie, and on `APIERROR 5` logs in again and retries the command once.
- **Timestamps.** Every command is sent with `dateformat="tzoffset"` so NetBox returns `YYYY-MM-DD HH:MM:SS ±HHMM`; `@spire/shared`'s `netboxTimeToIso` turns that into UTC.
- **Stream.** `EventStream.events()` is an async iterator that holds one connection, treats 30 s of silence as a dead link (NetBox sends a keep-alive every 10 s), reconnects with 1 s → 60 s backoff, and reports `connecting | connected | stream-down | stopped` through `onStatus`. It never replays the past: use `getAccessHistory({ afterLogId })` for catch-up.

- **Both versions.** v1 and v2 share the protocol; 6.x firmware moves the endpoints under `/nbws/` and answers 410 on the old paths. With `version: 'auto'` (default in the collector) `probe()` runs at startup, finds the working path family, reads `GetAPIVersion`, and reports both. Nothing to reconfigure on upgrade day.

Configuration knobs that may need adjusting once Sequoyah confirms Spire's unit: `bodyMode` (`raw`, the guide's wording, or `form` for an `APIcommand=` field), `sessionCookie`, `paths`, and a custom `undici` `Dispatcher` for a self-signed certificate.

## Developing

```bash
pnpm install
pnpm --filter @spire/collector test        # vitest, against test/fake-netbox.ts
pnpm --filter @spire/collector typecheck
```

`test/fake-netbox.ts` implements enough of NBAPI (login, paging, access history with `AFTERLOGID`, the chunked event stream with keep-alives) to run the whole client without hardware. When Sequoyah provides access, task 2.5 records real responses from Spire's NetBox as fixtures beside it.
