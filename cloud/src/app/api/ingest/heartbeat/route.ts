import { Heartbeat } from '@spire/shared';
import { NextResponse } from 'next/server';
import { json, readJson, requireCollector } from '@/lib/http';
import { recordHeartbeat } from '@/lib/ingest';
import { getRepo } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const who = await requireCollector(req);
  if (who instanceof NextResponse) return who;
  const parsed = Heartbeat.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: 'invalid heartbeat' }, 400);
  if (parsed.data.collectorId !== who.id) return json({ error: 'collectorId mismatch' }, 400);
  // Inventory refresh requests are stored as a flag on the collector's last heartbeat context in v1:
  // the admin UI sets `refreshRequested`; we clear it when we hand the action out.
  const row = await getRepo().getCollector(who.id);
  const actions =
    row?.lastHeartbeat &&
    (row.lastHeartbeat as unknown as { refreshRequested?: boolean }).refreshRequested
      ? (['refresh-inventory'] as const)
      : [];
  const res = await recordHeartbeat(getRepo(), who.id, parsed.data, [...actions]);
  return json(res);
}
