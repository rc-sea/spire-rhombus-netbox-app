# Spec Delta

## Purpose

Make silent failure impossible: the bridge must know, and tell someone, when the collector is down, NetBox stops streaming, Rhombus stops accepting, or events simply stop arriving.

## ADDED Requirements

### Requirement: Collector sends heartbeats
The collector SHALL send a heartbeat to the cloud service at least every 60 seconds containing: collector version, NetBox status (connected, stream-down, auth-failed, api-version-mismatch), NBAPI version reported by NetBox, last event received time, last reconciliation time and result, spool size, and host uptime.

#### Scenario: Heartbeat received
- **WHEN** the collector is healthy
- **THEN** the cloud service records a heartbeat no older than 60 seconds and shows the collector as "online"

### Requirement: Cloud service derives health states
The cloud service SHALL compute health states from heartbeats and publish results every minute and show them on the health page. The states are `collector-offline`, `netbox-stream-down`, `netbox-auth-failed`, `rhombus-failing`, `event-silence` and `backlog`; their thresholds are defined by the scenarios below and are configurable by an admin.

#### Scenario: Collector host loses power
- **WHEN** no heartbeat arrives for 3 minutes
- **THEN** state `collector-offline` is raised and shown on the health page

#### Scenario: NetBox stream down
- **WHEN** heartbeats report NetBox status "stream-down" for 5 consecutive minutes
- **THEN** state `netbox-stream-down` is raised

#### Scenario: NetBox authentication failed
- **WHEN** any heartbeat reports NetBox status "auth-failed"
- **THEN** state `netbox-auth-failed` is raised immediately

#### Scenario: Rhombus failing
- **WHEN** more than 5 publish attempts fail within 10 minutes, or Rhombus returns 401 or 403
- **THEN** state `rhombus-failing` is raised

#### Scenario: Event silence
- **WHEN** no events are ingested for the configured window (default 4 hours) outside quiet hours
- **THEN** state `event-silence` is raised

#### Scenario: Backlog
- **WHEN** the collector spool or the pending publish queue exceeds 500 items
- **THEN** state `backlog` is raised with the queue size

#### Scenario: Quiet hours
- **WHEN** no events are ingested between 01:00 and 05:00 local time and quiet hours cover that window
- **THEN** `event-silence` is not raised

#### Scenario: Recovery
- **WHEN** a condition that raised a state is no longer true for 2 consecutive checks
- **THEN** the state clears and a recovery notification is sent for states that were notified

### Requirement: Notifications are sent and rate-limited
The service SHALL notify configured recipients by email, and optionally a Slack webhook, when a health state is raised or cleared. Notifications for the same state MUST NOT repeat more than once per 6 hours while the state persists. Recipients and channels MUST be editable by an admin in the UI.

#### Scenario: Alert email
- **WHEN** `rhombus-failing` is raised
- **THEN** each configured recipient receives one email naming the state, the time, the last Rhombus error code, and a link to the health page

#### Scenario: No alert storm
- **WHEN** `collector-offline` persists for 24 hours
- **THEN** at most 4 notifications are sent for it in that period

### Requirement: Health page and endpoint
The service SHALL provide an authenticated health page showing current states, last heartbeat, counts of events ingested/published/failed/unmapped for the last hour and day, and the last 20 errors; and SHALL provide a machine-readable `/api/health` endpoint protected by a static token for external uptime monitoring that returns 200 when no state is raised and 503 otherwise.

#### Scenario: External monitor
- **WHEN** an uptime monitor calls `/api/health` with the token while `collector-offline` is raised
- **THEN** the response is 503 with a JSON body listing the raised states

### Requirement: NetBox-side faults are surfaced, not masked
When NetBox itself reports trouble on the stream (DESCNAME values such as "Network Node Timeout", "Network Node Disconnect", "Reader Communication Alarm", "System License Expired"), the service SHALL show them on the health page as "NetBox reported" items with their time, without treating them as bridge faults, and SHALL allow an admin to opt in to notifications for them.

#### Scenario: Node timeout reported
- **WHEN** NetBox streams "Network Node Timeout" for node "Garage P1"
- **THEN** the health page lists it under NetBox-reported items with the node name and time
