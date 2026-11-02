# Spec Delta

## Purpose

Restore the parking lobby displays with live Rhombus camera views and static notices, served as kiosk web pages that run unattended for weeks and never hold a long-lived Rhombus credential.

## ADDED Requirements

### Requirement: Each display has a configured layout
An admin SHALL be able to define one or more displays, each with a name, a layout (one view; two side by side; two by two; one large plus a text panel), the Rhombus camera(s) per tile, an optional static text panel (title, lines of text, optional image), and an optional rotation of camera sets with a dwell time. Configuration changes MUST reach a running display within 60 seconds without reloading the page manually.

#### Scenario: Two cameras plus notice
- **WHEN** an admin configures display "P1 Lobby" with cameras "P1 Ramp" and "P1 Gate" and a text panel "Visitor parking: levels P1 and P2"
- **THEN** the display page renders both live views and the notice in the chosen layout

#### Scenario: Layout change propagates
- **WHEN** an admin changes the layout while a display is running
- **THEN** the running page applies the new layout within 60 seconds

### Requirement: Display pages authenticate with a device token
Each display SHALL be opened with a URL containing a per-display device token that an admin can issue, view and revoke in the admin UI. The page MUST NOT require interactive sign-in, and the device token MUST grant nothing beyond fetching that display's configuration and short-lived Rhombus session tokens for its configured cameras.

#### Scenario: Revoked token
- **WHEN** an admin revokes a display's device token
- **THEN** the running page stops receiving video within one token-refresh interval and shows "Display disabled — contact management"

#### Scenario: Token used for another display
- **WHEN** a device token for display A is used to request display B's configuration
- **THEN** the request is refused

### Requirement: Rhombus credentials never reach the display
The cloud service SHALL mint short-lived Rhombus federated session tokens server-side (via `/api/org/generateFederatedSessionToken`) scoped to the display's cameras, hand them to the page, and refresh them before expiry. The Rhombus API key MUST NOT be present in the page, its bundle, or any response to the display.

#### Scenario: Token refresh
- **WHEN** a federated token is within 2 minutes of expiry
- **THEN** the page obtains a new one without interrupting playback

#### Scenario: Bundle inspection
- **WHEN** the display page bundle and network responses are inspected
- **THEN** no Rhombus API key is present

### Requirement: Display is resilient and unattended
The display page SHALL recover automatically from network loss, token failure, camera offline, and browser memory growth: it MUST reconnect video within 30 seconds of connectivity returning, MUST show a per-tile "camera offline" placeholder instead of a frozen frame, and MUST reload itself at least once every 24 hours at a configurable quiet time.

#### Scenario: Network blip
- **WHEN** the display PC loses network for 2 minutes
- **THEN** within 30 seconds of recovery all tiles show live video again without operator action

#### Scenario: Camera offline
- **WHEN** a configured camera is offline in Rhombus
- **THEN** its tile shows the camera name and "offline" and the other tiles keep playing

### Requirement: Display runs on the existing parking lobby PCs
The display page SHALL run in a current Chrome or Edge browser in kiosk mode at 1080p and 4K, with no plugins, and SHALL show a readable fallback (static text and last-known status) if the browser cannot decode the video stream.

#### Scenario: Decoder unsupported
- **WHEN** the browser lacks the required video decoding support
- **THEN** the page shows the static panel and a message "Live video unavailable on this device" instead of a blank screen

### Requirement: Display health is visible to admins
The admin UI SHALL show each display's last check-in time, current layout, token status and the last error reported by the page, and the bridge-health-alerting capability SHALL raise `display-offline` when a display has not checked in for 10 minutes during its scheduled hours.

#### Scenario: Display PC powered off
- **WHEN** a display stops checking in for 10 minutes during scheduled hours
- **THEN** `display-offline` is raised naming the display
