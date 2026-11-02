# LenelS2 NetBox API (NBAPI) — working summary

Source: *Web-Based API for NetBox and NetBox Global*, LenelS2 document API-UG-22, April 2024 (current with NetBox 5.4.x / Global 2.19). The PDF is kept outside the repo (Spire board folder). Page numbers below are the guide's.

## Versions, and running on both

- NBAPI v1 deprecated in NetBox 5.6 (Nov 2022), retired in 6.0. For existing v1 users, upgrading to **6.2** disables v1 and enables v2.
- **v2 is the same protocol.** Same XML envelope, same `Login` session auth, same `CODE`/`ERRMSG`/`APIERROR` responses. v2 adds 24 commands (alarms, portal states, locations, virtual credentials, Mercury/SIO hardware) and changes 9 of the 81 v1 commands; elevators and floors still have no add/modify/delete. None of the collector's read-only commands are known to have changed, but this is unverified until we have the v2 guide. Source: a community client verified live against a NetBox 6.2.0 controller (J-MaFf/s2-netbox-mcp, PR #101, Sept 2026).
- **What actually changes on 6.x is the URL.** Commands move to `/nbws/goforms/nbapi`; the legacy `/goforms/nbapi` answers HTTP 410 on every request. The Event API path on 6.x is not publicly documented; we assume `/nbws/appd/nbapi` and `/nbws/appdevent/nbapi/event` and verify on upgrade day.
- The Data Integration tab on newer firmware has an explicit **Enable V2** checkbox beside Use Authentication and Use login username/password. On 5.6–5.x this may allow v1 and v2 at the same time, which would let the collector run on v2 now while braXos stays on v1. Ask Sequoyah for the current version and whether the checkbox is present.
- The v2 guide is LenelS2 document **#API2-UG-8 (April 2025)**, published on the NetBox controller's own help portal: Getting Started → Guides and Technical Notes → Programming Guides. Sequoyah can pull it, or we can once we have web access to the unit. The v1 guide we hold is #API-UG-22 (April 2024).
- `GetAPIVersion` (p. 95) returns the API software version. The collector's `NbapiClient.probe()` tries the legacy paths then `/nbws`, logs in, reads `GetAPIVersion`, and records which family answered; it runs on every start so the switch is visible without configuration changes. Set `pathFamily` explicitly only to skip the probe.

## Transport

- XML over HTTP POST. Pre-6.x: commands `http://<netbox>/goforms/nbapi`, event list/trigger `http://<netbox>/appd/nbapi`, event stream `http://<netbox>/appdevent/nbapi/event`. 6.x: the same under `/nbws/…` (commands verified; event paths assumed). Confirm HTTP vs HTTPS and certificate on Spire's unit.
- Envelope: `<NETBOX-API sessionid="…"><COMMAND name="X" num="1" dateformat="tzoffset"><PARAMS>…</PARAMS></COMMAND></NETBOX-API>`. `num` is always 1 (one command per message).
- Response: `<NETBOX sessionid="…"><RESPONSE command="X" num="1"><CODE>SUCCESS|FAIL|NOT FOUND</CODE><DETAILS>…</DETAILS></RESPONSE></NETBOX>`. API-level failures come back as `<RESPONSE><APIERROR>n</APIERROR></RESPONSE>` (table on p. 9; `5` = authentication failure / API not enabled).
- Max response block 176 KB. Dates are site-local unless `dateformat="tzoffset"` is set, which returns `YYYY-MM-DD HH:MM:SS ±HHMM`.

## Authentication (pp. 19–24)

- Prerequisite on NetBox (Sequoyah): Configuration → Site Settings → Network Controller → Data Integration tab: **Enabled**, **Use Authentication**, **Use login username/password for authentication**. The API user needs a role with API privileges (p. 18); we ask for a custom read-only role.
- `Login` with USERNAME/PASSWORD → `sessionid` (a long hash since 5.4). Carry it on every request. Session times out per the Web Site tab setting; `Limit Session to Single IP Address` defaults on. Always `Logout` on shutdown.
- MAC authentication (SHA-1 over message + 8-char secret + monotonically increasing sequence number) exists; we do not use it (fragile across restarts, SHA-1).

## Commands we use (read-only allow-list)

| Command | Page | Use |
| --- | --- | --- |
| `Login` / `Logout` | 148 | session |
| `PingApp` | 178 | liveness |
| `GetAPIVersion` | 95 | version in health |
| `StreamEvents` | 191 | real-time activity (see below) |
| `GetAccessHistory` | 76 | catch-up: `AFTERLOGID` (ascending), `MAXRECORDS`; returns ACCESS records with LOGID, PERSONID, READER, DTTM, NODEDTTM, TYPE, REASON, READERKEY, PORTALKEY, PORTALNAME; `NEXTLOGID` -1 when done; `NOT FOUND` when nothing new |
| `GetEventHistory` | 101 | activity-log events by time window (CSV in DETAILS); optional |
| `GetReaders` | 124 | reader inventory (READERKEY, NAME, DESCRIPTION), paged by STARTFROMKEY/NEXTKEY |
| `GetPortals` | 121 | portals with their readers and PORTAL ORDER |
| `GetElevators` / `GetFloors` | 100 / 103 | elevator inventory (verify shapes on Spire's firmware) |
| `ListEvents` | 145 | configured event names |

Everything else (Add*, Modify*, Delete*, Remove*, ActivateOutput, LockPortal, UnlockPortal, MomentaryUnlockPortal, SetThreatLevel, TriggerEvent, SwitchPartition, …) is refused by the client.

## StreamEvents (pp. 28–35, 191–192)

- Long-lived connection; responses stream as `<NETBOX><RESPONSE command="StreamEvents"><EVENT>…</EVENT></RESPONSE></NETBOX>` chunks. Keep-alive with zero events every 10 s. **Only one stream connection per program.** No replay of past events — hence `GetAccessHistory` reconciliation.
- Request lists TAGNAMES to include; tags that support filters can carry `<FILTERS><FILTER>…</FILTER></FILTERS>` (OR within a tag). We request: ACTIVITYID, DESCNAME, CDT, NDT, PERSONID, PERSONNAME, PORTALNAME, RDRNAME, ACNAME, DETAIL, NODENAME, NODEADDRESS, PARTNAME, EVTNAME, EVTPRIO, LOCATIONNAME, THREATNAME, UCBITLENGTH.
- DESCNAME values we map (full table pp. 29–33): Access Granted; Invalid Access (with DETAIL); Portal Held Open; Portal Forced Open; Portal Restored; Momentary Unlock; Unlock; Relock; Request Momentary Unlock; Elevator Access Granted; Elevator Access Denied; Elevator Free Access; Elevator Access Not Completed; Access Not Completed; Event Activated; Event Normal; plus NetBox-health items we surface but do not publish (Network Node Timeout/Disconnect/Restored, Reader Communication Alarm/Normal, System License Expired, Network Controller Startup/Shutdown).

## Gotchas

- Activity log retention defaults to 100,000 records (p. 76); long outages beyond that cannot be fully reconciled.
- If NetBox syncs people from Active Directory, NBAPI writes get overwritten (p. 1) — irrelevant to us (read-only) but explains why we never write.
- Global (NetBox Global) uses `/global/goforms/nbapi` and no MAC auth; Spire has a single NetBox, not Global.
