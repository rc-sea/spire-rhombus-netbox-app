import { z } from 'zod';

const ServerEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  RHOMBUS_API_KEY: z.string().min(1),
  RHOMBUS_BASE_URL: z.string().url().default('https://api2.rhombussystems.com'),
  CRON_SECRET: z.string().min(16),
  HEALTH_TOKEN: z.string().min(16),
  SITE_TIMEZONE: z.string().default('America/Los_Angeles'),
});
export type ServerEnv = z.infer<typeof ServerEnv>;

let cached: ServerEnv | undefined;
/** Server-only. Never import from a client component. */
export function serverEnv(): ServerEnv {
  if (!cached) cached = ServerEnv.parse(process.env);
  return cached;
}
