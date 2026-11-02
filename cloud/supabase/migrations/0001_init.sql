-- Spire bridge: initial schema. See openspec design.md Decision 6.
-- Service routes use the service-role key (bypasses RLS). The admin UI uses
-- Supabase Auth; policies below grant viewers read and admins write.

create extension if not exists pgcrypto;

-- Who may use the admin UI, and how. Rows are created by an admin (or by hand in the dashboard).
create table public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('viewer', 'admin')),
  created_at  timestamptz not null default now()
);

create or replace function public.bridge_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

-- Collectors and their hashed bearer secrets.
create table public.collectors (
  id              text primary key,
  name            text not null,
  secret_hash     text not null,                 -- sha256 hex of the bearer secret
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz,
  last_heartbeat  jsonb
);

-- Every bridged event, once.
create table public.events (
  id              text primary key,
  collector_id    text not null references public.collectors (id),
  source          text not null check (source in ('stream', 'history')),
  kind            text not null,
  occurred_at     timestamptz not null,
  received_at     timestamptz not null,
  ingested_at     timestamptz not null default now(),
  netbox          jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'published', 'partial', 'failed', 'unmapped', 'ignored')),
  target_cameras  text[] not null default '{}'
);
create index events_occurred_at_idx on public.events (occurred_at desc);
create index events_kind_idx on public.events (kind);
create index events_status_idx on public.events (status);
create index events_reader_idx on public.events ((netbox->>'readerName'));
create index events_person_idx on public.events ((netbox->>'personName'));

-- One publish job per (event, camera).
create table public.publish_jobs (
  id               bigserial primary key,
  event_id         text not null references public.events (id) on delete cascade,
  camera_uuid      text not null,
  status           text not null default 'pending' check (status in ('pending', 'published', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error_code  text,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (event_id, camera_uuid)
);
create index publish_jobs_due_idx on public.publish_jobs (status, next_attempt_at);

-- What the collector reports exists in NetBox.
create table public.netbox_inventory (
  type        text not null check (type in ('reader', 'portal', 'elevator', 'floor', 'event')),
  key         text not null,
  name        text not null,
  description text,
  readers     jsonb,
  raw         jsonb,
  seen_at     timestamptz not null default now(),
  missing     boolean not null default false,  -- not in the latest snapshot
  primary key (type, key)
);

-- What exists in Rhombus.
create table public.rhombus_cameras (
  uuid        text primary key,
  name        text not null,
  location    text,
  seen_at     timestamptz not null default now(),
  missing     boolean not null default false
);

-- NetBox source → Rhombus camera.
create table public.mappings (
  id                   bigserial primary key,
  source_type          text not null check (source_type in ('reader', 'portal', 'elevator', 'event')),
  source_key           text not null,
  source_name_snapshot text not null,
  camera_uuid          text not null,
  enabled              boolean not null default true,
  overlay              boolean,                   -- null = use kind default
  color_override       text check (color_override in ('BLUE','RED','PURPLE','TAN','ORANGE','TEAL','GRAY','BLACK')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (source_type, source_key, camera_uuid)
);
create index mappings_source_idx on public.mappings (source_type, source_key) where enabled;

-- Singleton settings row.
create table public.settings (
  id                  int primary key default 1 check (id = 1),
  unmapped_policy     text not null default 'ignore' check (unmapped_policy in ('ignore', 'catch-all')),
  catch_all_camera    text,
  publish_kinds       text[] not null default '{access-granted,access-denied,access-not-completed,door-forced,door-held,door-restored,door-unlock,elevator-granted,elevator-denied,elevator-free-access,elevator-not-completed,event-activated}',
  overlay_kinds       text[] not null default '{door-forced,access-denied}',
  quiet_hours         jsonb not null default '{"start":"01:00","end":"05:00","days":[0,1,2,3,4,5,6]}',
  event_silence_hours int not null default 4,
  alert_recipients    text[] not null default '{}',
  slack_webhook       text,
  updated_at          timestamptz not null default now()
);
insert into public.settings (id) values (1);

create table public.displays (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  layout             jsonb not null,
  device_token_hash  text,
  token_issued_at    timestamptz,
  last_checkin_at    timestamptz,
  last_error         text,
  schedule           jsonb,                      -- hours during which display-offline applies
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.health_states (
  state             text primary key,
  raised_at         timestamptz,
  cleared_at        timestamptz,
  last_notified_at  timestamptz,
  clear_streak      int not null default 0,
  context           jsonb
);

create table public.audit_log (
  id          bigserial primary key,
  actor       text not null,                     -- user email, 'collector:<id>' or 'system'
  action      text not null,
  object_type text not null,
  object_id   text,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);
create index audit_log_at_idx on public.audit_log (at desc);

-- Row-level security: service role bypasses; authenticated users per role.
alter table public.profiles         enable row level security;
alter table public.collectors       enable row level security;
alter table public.events           enable row level security;
alter table public.publish_jobs     enable row level security;
alter table public.netbox_inventory enable row level security;
alter table public.rhombus_cameras  enable row level security;
alter table public.mappings         enable row level security;
alter table public.settings         enable row level security;
alter table public.displays         enable row level security;
alter table public.health_states    enable row level security;
alter table public.audit_log        enable row level security;

create policy "profiles: self read"      on public.profiles for select using (user_id = auth.uid());
create policy "profiles: admin all"      on public.profiles for all using (public.bridge_role() = 'admin');

create policy "viewers read"  on public.events           for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.publish_jobs     for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.netbox_inventory for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.rhombus_cameras  for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.mappings         for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.settings         for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.displays         for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.health_states    for select using (public.bridge_role() in ('viewer', 'admin'));
create policy "viewers read"  on public.audit_log        for select using (public.bridge_role() in ('viewer', 'admin'));
-- Collectors: viewers see names and last heartbeat but never the hash (column grants below).
create policy "viewers read"  on public.collectors       for select using (public.bridge_role() in ('viewer', 'admin'));

create policy "admins write"  on public.mappings  for all using (public.bridge_role() = 'admin') with check (public.bridge_role() = 'admin');
create policy "admins write"  on public.settings  for all using (public.bridge_role() = 'admin') with check (public.bridge_role() = 'admin');
create policy "admins write"  on public.displays  for all using (public.bridge_role() = 'admin') with check (public.bridge_role() = 'admin');
create policy "admins write"  on public.collectors for all using (public.bridge_role() = 'admin') with check (public.bridge_role() = 'admin');

revoke all on public.collectors from authenticated;
grant select (id, name, created_at, last_seen_at, last_heartbeat) on public.collectors to authenticated;
grant insert, update, delete on public.collectors to authenticated;  -- still gated by the admin policy
