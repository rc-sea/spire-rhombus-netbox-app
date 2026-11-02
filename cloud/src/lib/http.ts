import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authenticateCollector } from './collector-auth';
import { serverEnv } from './env';
import { getRepo } from './services';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Collector routes: Authorization: Bearer <collectorId>.<secret> */
export async function requireCollector(req: Request): Promise<{ id: string } | NextResponse> {
  const who = await authenticateCollector(getRepo(), req.headers.get('authorization'));
  return who ?? json({ error: 'unauthorized' }, 401);
}

function bearerEquals(req: Request, expected: string): boolean {
  const got = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel Cron routes: Authorization: Bearer $CRON_SECRET */
export function requireCron(req: Request): NextResponse | null {
  return bearerEquals(req, serverEnv().CRON_SECRET) ? null : json({ error: 'unauthorized' }, 401);
}

/** External uptime monitor: Authorization: Bearer $HEALTH_TOKEN (or ?token=) */
export function requireHealthToken(req: Request): NextResponse | null {
  const url = new URL(req.url);
  const q = url.searchParams.get('token');
  const ok =
    bearerEquals(req, serverEnv().HEALTH_TOKEN) || (q !== null && q === serverEnv().HEALTH_TOKEN);
  return ok ? null : json({ error: 'unauthorized' }, 401);
}
