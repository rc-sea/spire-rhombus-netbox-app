# cloud

Next.js 16 (App Router) on Vercel + Supabase Postgres. Receives events from the collector, maps NetBox sources to Rhombus cameras, publishes timeline markers, and (groups 5–7) hosts the admin UI, health/alerts and the parking lobby displays.

| Piece | State |
| --- | --- |
| Schema (`supabase/migrations/`) | applied to project `xrrroiletweovpfjowbq` |
| `/api/ingest/*`, `/api/cron/publish`, `/api/events`, `/api/health` | done, unit-tested against an in-memory repo; `next build` passes |
| Admin UI, auth pages | group 5 |
| Health evaluator, notifications | group 6 |
| Display pages, federated tokens | group 7 |

See `docs/api.md` for endpoints and `.env.example` for configuration. Deploy by connecting the GitHub repo to the Vercel project with root directory `cloud/` and setting the variables from `.env.example`; Vercel Cron picks up `vercel.json`.

```bash
pnpm --filter @spire/cloud test
pnpm --filter @spire/cloud typecheck
pnpm --filter @spire/cloud dev    # needs .env.local
```
