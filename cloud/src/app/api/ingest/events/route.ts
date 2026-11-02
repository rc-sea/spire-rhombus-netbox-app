import { NextResponse } from 'next/server';
import { json, readJson, requireCollector } from '@/lib/http';
import { ingestEvents } from '@/lib/ingest';
import { publishDue } from '@/lib/publisher';
import { getRepo, getRhombus } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const who = await requireCollector(req);
  if (who instanceof NextResponse) return who;
  const body = await readJson(req);
  const repo = getRepo();
  const out = await ingestEvents(repo, who.id, body);
  // Best-effort immediate publish; the cron drains anything this misses.
  if (out.inserted.length > 0) {
    try {
      await publishDue(repo, getRhombus(), { limit: 200 });
    } catch (err) {
      console.warn('immediate publish failed', (err as Error).message);
    }
  }
  return json(out.response);
}
