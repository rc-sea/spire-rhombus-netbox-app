import { json, requireCron } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Health evaluation lands in group 6; the cron entry exists so the schedule is in place. */
export async function GET(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;
  return json({ ok: true, evaluated: false });
}
