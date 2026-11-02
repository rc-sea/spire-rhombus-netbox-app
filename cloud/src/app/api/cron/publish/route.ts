import { json, requireCron } from '@/lib/http';
import { publishDue } from '@/lib/publisher';
import { getRepo, getRhombus } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;
  const summary = await publishDue(getRepo(), getRhombus(), { limit: 500 });
  return json(summary);
}
