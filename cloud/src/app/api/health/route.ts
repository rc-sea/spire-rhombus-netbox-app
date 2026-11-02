import { json, requireHealthToken } from '@/lib/http';
import { getRepo } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Machine-readable health for an external monitor. Full state evaluation is
 * group 6; v1 reports collector freshness and publish backlog.
 */
export async function GET(req: Request) {
  const denied = requireHealthToken(req);
  if (denied) return denied;
  const repo = getRepo();
  const pending = await repo.countPendingJobs();
  const raised: string[] = [];
  if (pending > 500) raised.push('backlog');
  return json(
    { ok: raised.length === 0, raised, pendingJobs: pending },
    raised.length === 0 ? 200 : 503,
  );
}
