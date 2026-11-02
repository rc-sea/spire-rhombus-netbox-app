# Deploying the collector on the building LAN

The collector is one Docker container. It needs to reach NetBox on the LAN and the cloud service over HTTPS, and nothing needs to reach it.

## Host

- A small always-on machine on the same network as NetBox: a mini PC or NUC with 4 GB RAM and 32 GB disk is plenty. Do not share the braXos server unless braXos agrees in writing.
- Any OS that runs Docker Engine 24+ with Compose v2 (Ubuntu Server LTS is the simplest). Set the host to auto-login-less, auto-start Docker, and reboot cleanly on power loss (BIOS "power on after loss").
- Firewall: outbound TCP 443 to the cloud service's host (`*.vercel.app`, or the custom domain), and outbound to NetBox's IP on its web port (80 or 443). The collector never talks to Rhombus; the cloud does. No inbound rules.
- Time: NTP enabled. Event timestamps come from NetBox, but the spool and health use host time.

## Before first start (from Sequoyah)

| Item | Where it goes |
| --- | --- |
| NetBox IP/hostname and web port, HTTP or HTTPS | `NETBOX_BASE_URL` in `.env` |
| A dedicated NetBox user with API privileges and a read-only role | `NETBOX_USERNAME` in `.env`; password in `secrets/netbox_password` |
| NBAPI enabled on Configuration → Site Settings → Network Controller → Data Integration: Enabled, Use Authentication, Use login username/password (and "Enable V2" if present) | nothing to configure here; the collector probes |
| Current NetBox version | record in `docs/environment.md` |

And from the cloud admin UI: a collector secret (Settings → Collectors → New). It is shown once; put it in `secrets/cloud_secret`.

## Install

```bash
sudo mkdir -p /opt/spire-collector && cd /opt/spire-collector
sudo curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/rc-sea/spire-rhombus-netbox-app/main/collector/docker-compose.yml
sudo curl -fsSLo .env https://raw.githubusercontent.com/rc-sea/spire-rhombus-netbox-app/main/collector/.env.example
sudo mkdir -p secrets && sudo chmod 700 secrets
sudo sh -c 'printf "%s" "NETBOX-PASSWORD-HERE" > secrets/netbox_password'
sudo sh -c 'printf "%s" "COLLECTOR-SECRET-HERE" > secrets/cloud_secret'
sudo chmod 600 secrets/*
sudo nano .env            # NETBOX_BASE_URL, NETBOX_USERNAME, CLOUD_BASE_URL
sudo docker compose pull && sudo docker compose up -d
sudo docker compose logs -f
```

A healthy start logs, in order: `NetBox probe` (with `pathFamily` and `apiVersion`), `collector started`, `NetBox stream connected`, `inventory published`. The cloud health page shows the collector online within a minute.

Until an image is published to GHCR, build locally instead of `pull`:

```bash
git clone https://github.com/rc-sea/spire-rhombus-netbox-app /opt/spire-src
sudo docker build -f /opt/spire-src/collector/Dockerfile -t ghcr.io/rc-sea/spire-collector:latest /opt/spire-src
```

## Operating

- **Logs:** `docker compose logs --since 1h collector`. JSON lines; `LOG_LEVEL=debug` in `.env` for more.
- **Health from the host:** `docker exec spire-collector node -e "fetch('http://127.0.0.1:9108').then(r=>r.text()).then(console.log)"` prints the same heartbeat the cloud sees.
- **Upgrade:** `docker compose pull && docker compose up -d`. The spool volume persists; undelivered events are kept across restarts.
- **Rollback:** pin a previous tag in `docker-compose.yml` (`:v0.1.0`) and `up -d` again.
- **Stop (e.g. during the NetBox update):** `docker compose stop`. Nothing in NetBox changes; on `start` the collector reconciles the gap from access history.
- **NetBox update day:** nothing to change. The collector will log `HTTP 410` on the legacy path, move to `/nbws`, and report the new `apiVersion` in the next heartbeat. If the stream stays `stream-down` afterwards, the 6.x event-stream path differs from our assumption: set `NBAPI_STREAM_PATH` after checking with Sequoyah (see `docs/netbox-nbapi.md`).

## What is on the box

Only the compose file, `.env` (no secrets), the `secrets/` directory (mode 600), the image, and the `/data` volume with the SQLite spool. The image contains no credentials.
