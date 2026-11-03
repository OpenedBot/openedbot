begin;

create table profile_import_jobs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by_user_id uuid references users(id) on delete set null,
  runtime_id uuid not null,
  section_id uuid not null,
  idempotency_key uuid not null,
  digest text not null check (length(digest) = 64),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','needs_attention')),
  phase text not null default 'prevalidation' check (phase in ('prevalidation','creation','roster','capabilities','compensation','finished')),
  total_profiles integer not null check (total_profiles between 1 and 32),
  completed_profiles integer not null default 0 check (completed_profiles between 0 and 32),
  result jsonb,
  error jsonb,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  acknowledged_at timestamptz,
  review_after timestamptz,
  acknowledged_by uuid references users(id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id)
);

create unique index profile_import_one_active_idx on profile_import_jobs (organization_id)
  where status in ('queued','running');
create index profile_import_claim_idx on profile_import_jobs (created_at, id)
  where status in ('queued','running');
create index profile_import_history_idx on profile_import_jobs (organization_id, created_at desc, id desc);

create table profile_import_items (
  job_id uuid not null,
  organization_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 31),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$' and slug <> 'default'),
  entry jsonb,
  bot_id uuid not null,
  thread_id uuid not null,
  avatar_id uuid not null,
  avatar_stored boolean not null default false,
  creation_state text not null default 'not_started'
    check (creation_state in ('not_started','sending','created','not_created','deleting','deleted','unknown')),
  operation jsonb,
  selection jsonb,
  bot_model text,
  limitations jsonb not null default '[]'::jsonb,
  capabilities_done boolean not null default false,
  completed_operations jsonb not null default '[]'::jsonb,
  reservation_released_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (job_id, ordinal),
  unique (job_id, slug),
  foreign key (organization_id, job_id) references profile_import_jobs(organization_id, id) on delete cascade
);

create unique index profile_import_reserved_name_idx on profile_import_items (organization_id, slug)
  where reservation_released_at is null;

alter table profile_import_jobs enable row level security;
alter table profile_import_jobs force row level security;
alter table profile_import_items enable row level security;
alter table profile_import_items force row level security;

create policy profile_import_jobs_tenant on profile_import_jobs to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy profile_import_items_tenant on profile_import_items to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy profile_import_jobs_worker on profile_import_jobs to ohb_worker using (true) with check (true);
create policy profile_import_items_worker on profile_import_items to ohb_worker using (true) with check (true);
grant select, insert, update on profile_import_jobs, profile_import_items to ohb_api;
grant select, insert, update, delete on profile_import_jobs, profile_import_items to ohb_worker;

comment on table profile_import_jobs is 'Durable bounded Hermes archive imports; no raw YAML, credentials or skill content.';
comment on column profile_import_items.operation is 'Committed before external mutation; an unresolved intent is never replayed after lease loss.';
comment on column profile_import_items.reservation_released_at is 'Unknown host outcomes remain reserved until explicit human acknowledgement.';

insert into schema_migrations(version) values ('0056_profile_import_jobs') on conflict (version) do nothing;
commit;
