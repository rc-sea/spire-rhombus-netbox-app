import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import type { EventStatus } from '@/lib/db/repo';
import { json } from '@/lib/http';
import { getRepo } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Event log query for the admin UI: viewer or admin. */
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const p = new URL(req.url).searchParams;
  const q = {
    ...(p.get('from') ? { from: p.get('from') as string } : {}),
    ...(p.get('to') ? { to: p.get('to') as string } : {}),
    ...(p.get('kind') ? { kind: p.get('kind') as string } : {}),
    ...(p.get('reader') ? { reader: p.get('reader') as string } : {}),
    ...(p.get('person') ? { person: p.get('person') as string } : {}),
    ...(p.get('status') ? { status: p.get('status') as EventStatus } : {}),
    limit: Math.min(Number(p.get('limit') ?? 100) || 100, 1000),
  };
  const events = await getRepo().queryEvents(q);
  return json({ events });
}
