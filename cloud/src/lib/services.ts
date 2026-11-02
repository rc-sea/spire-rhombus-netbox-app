/**
 * Composition root for server code: one place that knows about env, the
 * Supabase repo and the Rhombus client. Routes import from here.
 */
import { SupabaseRepo } from './db/supabase-repo';
import { serverEnv } from './env';
import { RhombusClient } from './rhombus';

let repo: SupabaseRepo | undefined;
let rhombus: RhombusClient | undefined;

export function getRepo(): SupabaseRepo {
  if (!repo) repo = SupabaseRepo.fromEnv();
  return repo;
}

export function getRhombus(): RhombusClient {
  if (!rhombus) {
    const env = serverEnv();
    rhombus = new RhombusClient({ apiKey: env.RHOMBUS_API_KEY, baseUrl: env.RHOMBUS_BASE_URL });
  }
  return rhombus;
}
