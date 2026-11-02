-- Bulk job state transitions, called by the publisher with the service role.

create or replace function public.mark_jobs_published(job_ids bigint[], at timestamptz)
returns void language sql security definer set search_path = public as $$
  update public.publish_jobs
     set status = 'published', published_at = at, attempts = attempts + 1, last_error_code = null
   where id = any(job_ids);
$$;

create or replace function public.mark_jobs_retry(job_ids bigint[], next_at timestamptz, code text)
returns void language sql security definer set search_path = public as $$
  update public.publish_jobs
     set attempts = attempts + 1, next_attempt_at = next_at, last_error_code = code
   where id = any(job_ids);
$$;

create or replace function public.mark_jobs_failed(job_ids bigint[], code text)
returns void language sql security definer set search_path = public as $$
  update public.publish_jobs
     set status = 'failed', attempts = attempts + 1, last_error_code = code
   where id = any(job_ids);
$$;

revoke all on function public.mark_jobs_published(bigint[], timestamptz) from public, anon, authenticated;
revoke all on function public.mark_jobs_retry(bigint[], timestamptz, text) from public, anon, authenticated;
revoke all on function public.mark_jobs_failed(bigint[], text) from public, anon, authenticated;
