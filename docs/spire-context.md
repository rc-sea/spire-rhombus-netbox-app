# Spire building-systems context

Why this project exists and how it fits the rest of the Spire Condominium systems. Written 2026-11-02 from the board's working documents and the Sequoyah thread of late October 2026.

## The systems (all are staying)

| System | Role | Vendor / contact | Status |
| --- | --- | --- | --- |
| LenelS2 NetBox (on-prem appliance) | Access control system of record: people, fobs, doors, floor rights. Hub for everything except video. | Sequoyah (LenelS2 integrator) | Works; SUSP lapsed (renewal $1,000/yr); on NBAPI v1 until updated to 6.2+ |
| braXos Steward | Security head-end for Otis Compass destination dispatch; mirrors NetBox access levels into Otis; grants ButterflyMX visitors a temporary floor | braXos (via Sequoyah or direct) | Works; no support contract; on an unsupported PC; uses NBAPI v1 |
| Otis Compass | Elevator destination dispatch (lobby kiosks) | Otis | Works via braXos |
| ButterflyMX | Visitor intercom / PINs; door release wired through NetBox | ButterflyMX | Works |
| Parkworks | Garage ramp signage. **Hard-wired outputs from Parkworks into NetBox inputs — no API.** | Parkworks | Works; unaffected by NetBox API changes |
| Rhombus | Cloud video platform; nearly all cameras migrated | Rhombus dealer | Works; connected to nothing |
| Magic Monitor (LenelS2) | Parking lobby displays, formerly fed live video by the NetVR/VRx camera server | Sequoyah | Camera server is dead; displays dark |

## What this project does and does not do

Does:
- Reads NetBox activity (fob reads, door forced/held, elevator events, ButterflyMX releases as portal events) and posts them as markers on the right Rhombus camera timelines.
- Gives the property manager a UI to map NetBox readers/portals to cameras, see health, and get alerts.
- Provides kiosk pages for the parking lobby displays showing live Rhombus views plus static notices (no Sequoyah involvement, no Magic Monitor).

Does not:
- Write to NetBox. Ever.
- Stream Rhombus video into NetBox/Magic Monitor. Sequoyah confirmed it is not needed and would need NetBox third-party video licensing plus per-camera fees (the old camera server licence alone was about $5,500/yr).
- Touch braXos, Otis, ButterflyMX, or Parkworks.

## Why not wait for Rhombus

Rhombus shipped LenelS2 Elements (June 2026) and OnGuard (August 2026, OAAP-certified) integrations. NetBox is "in progress" with no date; Rhombus's own developer tooling already references NetBox badge events. The bridge is designed so the collector/publisher can be switched off if Rhombus ships NetBox support; the admin UI, health and displays stay useful.

## Sequencing with the wider plan

1. Now: NetBox SUSP licence renewal; braXos quote (support, server, migration); Rhombus dealer confirms API access and camera licences.
2. Displays can ship immediately (Rhombus only).
3. Collector ships against NBAPI v1 on the current NetBox.
4. braXos upgrade, then the NetBox 6.2+ update (which removes NBAPI v1). Collector switches to v2 by configuration.

## People

- RC — board, project owner, developer.
- Sequoyah — LenelS2 integrator (NetBox, Magic Monitor). Enables NBAPI, creates the API user.
- Rhombus dealer — Rhombus licensing, API access, camera/recording licences.
- Property manager — day-to-day operator of NetBox and of this bridge's admin UI.
