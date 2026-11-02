/**
 * Admin-UI sessions via Supabase Auth cookies. Roles come from public.profiles.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { serverEnv } from '../env';

export interface SessionUser {
  id: string;
  email: string;
  role: 'viewer' | 'admin';
}

export async function currentUser(): Promise<SessionUser | null> {
  const env = serverEnv();
  const store = await cookies();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: () => {
          /* read-only in route handlers; middleware refreshes */
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const prof = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', data.user.id)
    .maybeSingle();
  const role = prof.data?.role as SessionUser['role'] | undefined;
  if (!role) return null;
  return { id: data.user.id, email: data.user.email ?? '', role };
}

export async function requireUser(
  role: 'viewer' | 'admin' = 'viewer',
): Promise<SessionUser | NextResponse> {
  const u = await currentUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (role === 'admin' && u.role !== 'admin')
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return u;
}
