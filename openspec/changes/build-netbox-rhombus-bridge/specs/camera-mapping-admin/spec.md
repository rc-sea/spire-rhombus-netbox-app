# Spec Delta

## Purpose

Give the property manager and board a safe, self-explanatory web UI to decide which Rhombus cameras each NetBox reader, portal, elevator or event maps to, backed by live inventories from both systems and a full audit trail.

## ADDED Requirements

### Requirement: Admin UI requires authenticated, role-scoped users
The admin UI and its API SHALL require sign-in (email magic link or OAuth) and SHALL distinguish two roles: `viewer` (read mappings, events, health) and `admin` (edit mappings, settings, displays). Sessions MUST expire after 12 hours of inactivity. There SHALL be no anonymous access to any admin route.

#### Scenario: Viewer attempts an edit
- **WHEN** a signed-in viewer submits a mapping change
- **THEN** the API responds 403 and no change is stored

#### Scenario: Unauthenticated request
- **WHEN** an admin route is requested without a valid session
- **THEN** the service redirects to sign-in (UI) or responds 401 (API)

### Requirement: Mapping sources come from live NetBox inventory
The mapping editor SHALL list NetBox readers, portals (with their readers), elevators and configured event names from the latest inventory published by the collector, showing each item's NetBox name and key, and SHALL flag any mapped source that no longer appears in the inventory as "missing in NetBox".

#### Scenario: New reader added in NetBox
- **WHEN** Sequoyah adds a reader in NetBox and the next inventory refresh runs
- **THEN** the reader appears in the editor as unmapped within one refresh interval

#### Scenario: Reader renamed in NetBox
- **WHEN** a mapped reader's name changes in NetBox but its key is unchanged
- **THEN** the mapping is preserved by key and the editor shows the new name

### Requirement: Mapping targets come from live Rhombus inventory
The mapping editor SHALL list Rhombus cameras (name, UUID, location) fetched from the Rhombus API on demand and cached, and SHALL flag any mapped camera that no longer exists as "missing in Rhombus".

#### Scenario: Camera list refresh
- **WHEN** an admin clicks "Refresh cameras"
- **THEN** the editor shows the current Rhombus camera list within 10 seconds

### Requirement: Admin can map a source to one or more cameras
An admin SHALL be able to map each NetBox source to zero or more Rhombus cameras, set per-mapping options (enabled, overlay on/off, colour override), and set the global default for unmapped sources (ignore or catch-all camera). Changes MUST take effect for new events within 30 seconds without a redeploy.

#### Scenario: Map garage entry reader to two cameras
- **WHEN** an admin maps reader "P1 Garage Entry" to cameras "P1 Ramp" and "P1 Gate" and saves
- **THEN** subsequent events from that reader publish to both cameras

#### Scenario: Disable a mapping
- **WHEN** an admin toggles a mapping to disabled
- **THEN** subsequent events from that source are stored as `unmapped` and no seekpoints are created

### Requirement: Mappings can be bulk-exported and imported
The service SHALL export the full mapping as a JSON or CSV file and SHALL accept the same format for import with a dry-run preview showing adds, changes and removals before applying.

#### Scenario: Import preview
- **WHEN** an admin uploads a mapping file
- **THEN** the UI shows a diff and nothing changes until the admin confirms

### Requirement: Every change is audited
The service SHALL record who changed what and when for every mapping, setting and display-configuration change, and SHALL show the audit log in the UI (newest first, filterable by user and object).

#### Scenario: Audit entry on save
- **WHEN** an admin saves a mapping change
- **THEN** an audit record with the user, timestamp, object, before and after values is stored and visible in the audit view

### Requirement: Test a mapping end to end
An admin SHALL be able to trigger a test seekpoint named "Bridge test" on any mapped camera at the current time from the UI, so a mapping can be verified in the Rhombus Console without waiting for a real event.

#### Scenario: Test seekpoint
- **WHEN** an admin clicks "Send test marker" on a mapping
- **THEN** a seekpoint named "Bridge test" appears on that camera's Rhombus timeline at the current time and the UI reports success or the Rhombus error code
