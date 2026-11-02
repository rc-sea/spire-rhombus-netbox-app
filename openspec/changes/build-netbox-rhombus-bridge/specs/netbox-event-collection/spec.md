# Spec Delta

## Purpose

Collect access-control activity from the on-prem LenelS2 NetBox in real time, recover anything missed during outages, normalize it into a stable bridge event schema, and deliver it to the cloud bridge service reliably from inside the building network without exposing NetBox.

## ADDED Requirements

### Requirement: Collector authenticates to NetBox with a dedicated read-only API user
The collector SHALL authenticate to NetBox using NBAPI user-login authentication (`Login` command, session ID carried on every subsequent request) with a dedicated NetBox user whose role grants API privileges and no setup or data-modification rights. The collector MUST issue `Logout` on orderly shutdown and MUST re-login automatically when a session expires.

#### Scenario: Successful login on startup
- **WHEN** the collector starts with valid NetBox host, username and password
- **THEN** it issues `Login`, stores the returned session ID, and reports NetBox status "connected"

#### Scenario: Session expiry
- **WHEN** a NetBox response indicates an invalid or expired session (`APIERROR` or `CODE` of FAIL on a session-dependent command)
- **THEN** the collector logs in again and retries the failed command once before reporting an error

#### Scenario: Credentials rejected
- **WHEN** `Login` fails
- **THEN** the collector reports NetBox status "auth-failed", does not retry more than once per minute, and emits a health event (see bridge-health-alerting)

### Requirement: Collector subscribes to the NetBox activity stream
The collector SHALL maintain a single `StreamEvents` connection to `http(s)://<netbox>/appdevent/nbapi/event`, requesting at minimum the tags ACTIVITYID, DESCNAME, CDT, NDT, PERSONID, PERSONNAME, PORTALNAME, RDRNAME, ACNAME, DETAIL, NODENAME, PARTNAME, EVTNAME and LOCATIONNAME. It MUST treat the ten-second keep-alive as liveness and MUST reconnect with exponential backoff (1 s to 60 s) when the connection closes or no keep-alive arrives for 30 s.

#### Scenario: Event received on the stream
- **WHEN** NetBox streams an EVENT element with DESCNAME "Access Granted"
- **THEN** the collector emits one bridge event within 2 seconds carrying the event's tags and the stream receive time

#### Scenario: Stream silent
- **WHEN** no keep-alive or event arrives for 30 seconds
- **THEN** the collector closes the connection, marks NetBox status "stream-down", and reconnects with backoff

#### Scenario: Only one stream connection
- **WHEN** a reconnect is attempted while a previous connection is still closing
- **THEN** the collector waits for the previous connection to close before opening a new one, so NetBox never sees two concurrent stream clients from the collector

### Requirement: Collector recovers access history missed while disconnected
Because the NetBox stream delivers no past events, the collector SHALL persist the highest access-log ID it has delivered and, after every reconnect and on a fixed schedule (default every 5 minutes), SHALL call `GetAccessHistory` with `AFTERLOGID` to fetch and deliver any access records it has not already delivered.

#### Scenario: Gap after an outage
- **WHEN** the collector reconnects after 20 minutes offline and NetBox has 14 new access records since the last delivered LOGID
- **THEN** the collector delivers those 14 records as bridge events flagged `source: "history"` with their original NetBox timestamps

#### Scenario: Overlap between stream and history
- **WHEN** an access record was already delivered from the stream and is returned again by `GetAccessHistory`
- **THEN** the collector delivers it again only with the same idempotency key, so the cloud service can discard the duplicate

#### Scenario: No new history
- **WHEN** `GetAccessHistory` returns `NOT FOUND` for the stored AFTERLOGID
- **THEN** the collector records a successful reconciliation with zero new records

### Requirement: Collector normalizes NetBox activity into bridge events
The collector SHALL map every NetBox activity record to a versioned bridge event with an idempotency `id`, a UTC `occurredAt`, a `receivedAt`, a `kind` from a fixed list, a `source` (stream or history) and the raw NetBox tag values. Unknown DESCNAME values MUST map to kind `other` and MUST NOT be dropped. The full `kind` list is defined in `packages/shared` and covered by the scenarios below.

#### Scenario: Access Granted maps to access-granted
- **WHEN** a NetBox event has DESCNAME "Access Granted" with RDRNAME "Lobby Door" and PERSONNAME "J. Smith"
- **THEN** the bridge event has kind `access-granted`, `netbox.reader` "Lobby Door", `netbox.personName` "J. Smith"

#### Scenario: Invalid Access maps to access-denied with reason
- **WHEN** a NetBox event has DESCNAME "Invalid Access" and DETAIL "Card expired"
- **THEN** the bridge event has kind `access-denied` and `netbox.detail` "Card expired"

#### Scenario: Elevator events are preserved
- **WHEN** a NetBox event has DESCNAME "Elevator Access Granted" or "Elevator Free Access"
- **THEN** the bridge event kind is `elevator-granted` or `elevator-free-access` respectively

#### Scenario: Door events map to door kinds
- **WHEN** a NetBox event has DESCNAME "Portal Forced Open", "Portal Held Open", "Portal Restored", "Momentary Unlock", "Unlock" or "Relock"
- **THEN** the bridge event kind is `door-forced`, `door-held`, `door-restored`, `door-unlock`, `door-unlock` or `door-restored` respectively

#### Scenario: Timestamps are UTC
- **WHEN** NetBox reports CDT "2026-11-02 14:05:09 -0800"
- **THEN** the bridge event `occurredAt` is 2026-11-02T22:05:09Z

#### Scenario: Unknown event description
- **WHEN** a NetBox event has a DESCNAME the collector does not recognize
- **THEN** the bridge event has kind `other` and the raw DESCNAME is retained in `netbox.descName`

### Requirement: Collector delivers events to the cloud service at least once
The collector SHALL deliver bridge events to the cloud ingest endpoint over HTTPS using a per-collector bearer secret, in batches of at most 100, and SHALL persist undelivered events locally (bounded, oldest-dropped beyond 7 days or 100,000 events) so that cloud outages do not lose events. Delivery MUST be idempotent by event `id`.

#### Scenario: Cloud unavailable
- **WHEN** the ingest endpoint returns 5xx or is unreachable
- **THEN** the collector retries with exponential backoff, keeps spooling new events locally, and reports cloud status "backlogged" with the backlog size

#### Scenario: Cloud rejects authentication
- **WHEN** the ingest endpoint returns 401 or 403
- **THEN** the collector stops retrying that batch, reports cloud status "auth-failed", and does not discard the spooled events

#### Scenario: Batch acknowledged
- **WHEN** the ingest endpoint returns 2xx with the accepted event ids
- **THEN** the collector removes those events from its spool

### Requirement: Collector exposes NetBox inventory for mapping
The collector SHALL, on request from the cloud service and at least daily, fetch the NetBox reader list (`GetReaders`), portal list with readers (`GetPortals`), elevator list (`GetElevators`) and configured event names (`ListEvents`) and publish them to the cloud service so the admin UI can offer real NetBox sources for mapping.

#### Scenario: Inventory refresh
- **WHEN** the cloud service requests an inventory refresh
- **THEN** the collector publishes the current reader, portal, elevator and event lists with their NetBox keys within 60 seconds

### Requirement: Collector never writes to NetBox
The collector MUST use only read-type NBAPI commands (`Login`, `Logout`, `PingApp`, `GetAPIVersion`, `StreamEvents`, `GetAccessHistory`, `GetEventHistory`, `GetReaders`, `GetPortals`, `GetElevators`, `GetFloors`, `ListEvents`). Any code path that would issue another command MUST be rejected by the NBAPI client layer.

#### Scenario: Write command attempted
- **WHEN** any component asks the NBAPI client to send a command not on the read-only allow-list
- **THEN** the client refuses, logs the attempt, and no request is sent to NetBox

### Requirement: Collector supports NBAPI v1 now and v2 after the NetBox update
The collector SHALL support both NBAPI versions via configuration (`NBAPI_VERSION=1|2`, base path, HTTP vs HTTPS, certificate pinning or CA bundle) and SHALL report the version NetBox returns from `GetAPIVersion` in its health data.

#### Scenario: Version mismatch
- **WHEN** the configured NBAPI version differs from what `GetAPIVersion` reports after the NetBox update
- **THEN** the collector logs a warning naming both versions and continues if commands succeed, otherwise reports status "api-version-mismatch"

### Requirement: Collector runs unattended on the building LAN
The collector SHALL run as a single Docker container with no inbound listening ports other than an optional localhost-only health endpoint, SHALL restart automatically on failure, and SHALL read all secrets from environment or Docker secrets, never from the image.

#### Scenario: Host reboot
- **WHEN** the LAN host reboots
- **THEN** the collector starts automatically, logs in to NetBox, reconciles history, and resumes streaming without operator action

#### Scenario: Secrets not baked in
- **WHEN** the container image is inspected
- **THEN** it contains no NetBox or cloud credentials
