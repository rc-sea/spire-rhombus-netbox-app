# Spec Delta

## Purpose

Turn bridged NetBox events into markers on the right Rhombus camera timelines, reliably and without duplicates, and keep a queryable record of what was published so an operator can trust the timeline.

## ADDED Requirements

### Requirement: Cloud service ingests collector events idempotently
The cloud service SHALL expose an HTTPS ingest endpoint that accepts batches of bridge events from an authenticated collector, stores each event once by its `id`, and returns the ids accepted. Re-submission of an already stored id MUST be acknowledged without creating a second record or a second seekpoint.

#### Scenario: New batch accepted
- **WHEN** a collector posts 40 events with valid credentials
- **THEN** the service stores 40 event records and responds 200 with all 40 ids

#### Scenario: Duplicate ids
- **WHEN** a batch contains 5 ids already stored
- **THEN** those 5 are acknowledged, not stored again, and no additional seekpoints are created for them

#### Scenario: Invalid credentials
- **WHEN** the bearer secret is missing or wrong
- **THEN** the service responds 401 and stores nothing

#### Scenario: Schema violation
- **WHEN** an event fails schema validation
- **THEN** the service rejects that event with a per-event error, accepts the valid ones in the batch, and records the rejection for the health page

### Requirement: Each event resolves to zero or more target cameras
The service SHALL resolve each event to target cameras using the mapping maintained by camera-mapping-admin: by reader name, then portal name, then elevator/node name, then event name, with a configurable default for unmapped sources (publish to none, or publish to a "catch-all" camera). Events with no target MUST be stored and marked `unmapped`, never silently dropped.

#### Scenario: Reader mapped to two cameras
- **WHEN** an `access-granted` event arrives for reader "P1 Garage Entry" mapped to cameras A and B
- **THEN** one seekpoint is created on camera A and one on camera B

#### Scenario: Unmapped source
- **WHEN** an event's reader, portal and event name are all unmapped and no catch-all is configured
- **THEN** the event is stored with status `unmapped` and counted on the health page

### Requirement: Seekpoints carry the event at the correct time
For each target camera the service SHALL call `POST /api/camera/createCustomFootageSeekpoints` with `timestampMs` equal to the event's `occurredAt` (not the time of publishing), a `name` of at most 32 characters, a `description` of at most 100 characters, and a `color` chosen by event kind (granted: BLUE, denied: ORANGE, forced/held: RED, unlock/restored: TEAL, elevator: PURPLE, other: GRAY). Seekpoints MUST be created within 10 seconds of ingest under normal conditions.

#### Scenario: Name and description truncation
- **WHEN** the person name and reader name together exceed the limits
- **THEN** the name is truncated to 32 characters and the description to 100 characters without failing the call

#### Scenario: Historical event
- **WHEN** an event with `source: "history"` from 20 minutes ago is ingested
- **THEN** the seekpoint is created at the original `occurredAt` timestamp

#### Scenario: Display overlay
- **WHEN** an event kind is door-forced or access-denied
- **THEN** the seekpoint is created with `displayOverlay: true`; other kinds use the configured default (false)

### Requirement: Publishing is batched per camera and retried on failure
The service SHALL group pending seekpoints by camera and submit them in one call per camera (the endpoint accepts an array), SHALL honour Rhombus 429 responses with backoff, and SHALL retry 5xx and network failures with exponential backoff up to 24 hours. Per-event publish status (`pending`, `published`, `failed`, `unmapped`) MUST be recorded with the last error code.

#### Scenario: Rate limited
- **WHEN** Rhombus responds 429 RATE_LIMITED
- **THEN** the service pauses publishing for that camera for the backoff interval and retries without losing events

#### Scenario: Permanent rejection
- **WHEN** Rhombus responds 400 VALIDATION_FAILED for a batch
- **THEN** the service retries each event of the batch individually once, marks any still-failing event `failed` with the errorCode, and surfaces the count on the health page

#### Scenario: Camera no longer exists
- **WHEN** Rhombus rejects a camera UUID as unknown
- **THEN** affected events are marked `failed`, the mapping entry is flagged "camera missing" for the admin UI, and an alert is raised

### Requirement: Event log is queryable
The service SHALL retain bridged events and their publish status for at least 90 days and SHALL provide an authenticated query API and UI view filtered by time range, kind, reader/portal, person name and status, returning the Rhombus camera and timestamp for each published seekpoint so an operator can jump from an event to footage.

#### Scenario: Find who badged at a door
- **WHEN** an operator filters the log by reader "Lobby Door" and a 30-minute window
- **THEN** the service returns the matching events with person names, timestamps and the cameras they were published to

### Requirement: Rhombus credentials are least-privilege and server-only
The service SHALL use a Rhombus API key assigned a role limited to the camera and org operations the bridge needs, stored only in server-side configuration, and SHALL never return it in any API response, log line or client bundle.

#### Scenario: Key not leaked
- **WHEN** logs, error responses and the admin UI bundle are inspected
- **THEN** no Rhombus API key value appears
