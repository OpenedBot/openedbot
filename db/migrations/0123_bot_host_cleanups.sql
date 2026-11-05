begin;
create table bot_host_cleanups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  bot_deleted_at timestamptz not null,
  runtime_id uuid not null,
  profile text,
  session_profile text,
  session_ids text[] not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error jsonb,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id),
  check (cardinality(session_ids) <= 2000),
  check (attempts >= 0)
);
create unique index bot_host_cleanup_active_bot_idx on bot_host_cleanups (organization_id, bot_id)
  where status in ('queued','running','failed');
create index bot_host_cleanup_claim_idx on bot_host_cleanups (next_attempt_at, id)
  where status in ('queued','running');
alter table bot_host_cleanups enable row level security;
alter table bot_host_cleanups force row level security;
create policy bot_host_cleanups_tenant on bot_host_cleanups to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_host_cleanups_worker on bot_host_cleanups to openedbot_worker using (true) with check (true);
grant select, insert, update on bot_host_cleanups to openedbot_api;
grant select, insert, update on bot_host_cleanups to openedbot_worker;
comment on table bot_host_cleanups is 'Durable cleanup of bot sessions and owned profiles on client runtimes.';
insert into schema_migrations(version) values ('0123_bot_host_cleanups') on conflict (version) do nothing;
commit;
