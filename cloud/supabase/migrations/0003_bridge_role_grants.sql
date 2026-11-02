-- bridge_role() must stay SECURITY DEFINER (RLS on profiles would otherwise recurse),
-- but only signed-in users need to call it, and only via policies.
revoke execute on function public.bridge_role() from public, anon;
grant execute on function public.bridge_role() to authenticated;
