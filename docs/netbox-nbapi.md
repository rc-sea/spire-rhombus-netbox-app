# LenelS2 NetBox API (NBAPI) — working summary

Source: *Web-Based API for NetBox and NetBox Global*, LenelS2 document API-UG-22, April 2024 (current with NetBox 5.4.x / Global 2.19). The PDF is kept outside the repo (Spire board folder). Page numbers below are the guide's.

## Versions

- NBAPI v1 deprecated in NetBox 5.6 (Nov 2022), retired in 6.0. For existing v1 users, upgrading to **6.2** disables v1 and enables v2. The command set documented in API-UG-22 is what we target; keep the client behind one interface so the switch is `NBAPI_VERSION=2`.
- `GetAPIVersion` (p. 95) returns the API software version; log it on every collector start.

## Transport

- XML over HTTP POST. Commands: `http://<netbox>/goforms/nbapi`. Event list/trigger: `http://<netbox>/appd/nbapi`. Event stream: `http://<netbox>/appdevent/nbapi/event`. (Confirm HTTP vs HTTPS and certificate on Spire's unit.)
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
