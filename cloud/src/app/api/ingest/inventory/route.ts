import { InventorySnapshot } from '@spire/shared';
import { NextResponse } from 'next/server';
import { json, readJson, requireCollector } from '@/lib/http';
import { recordInventory } from '@/lib/ingest';
import { getRepo } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const who = await requireCollector(req);
  if (who instanceof NextResponse) return who;
  const parsed = InventorySnapshot.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: 'invalid inventory' }, 400);
  if (parsed.data.collectorId !== who.id) return json({ error: 'collectorId mismatch' }, 400);
  await recordInventory(getRepo(), parsed.data);
  return json({ ok: true, items: parsed.data.items.length });
}
