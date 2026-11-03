-- Suppressions de profils Hermes en lot, durables, comme les imports d'archive.
-- Un job par organisation à la fois (queued/running). Le worker avance slug
-- par slug, relit l'hôte, et n'efface la ligne SQL qu'après preuve.
begin;

create table profile_delete_jobs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by_user_id uuid references users(id) on delete set null,
  runtime_id uuid not null,
  slugs text[] not null check (cardinality(slugs) between 1 and 64),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  total_profiles integer not null check (total_profiles between 1 and 64),
  completed_profiles integer not null default 0 check (completed_profiles between 0 and 64),
  current_slug text,
  results jsonb not null default '[]'::jsonb,
  error jsonb,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id),
  check (total_profiles = cardinality(slugs)),
  check (completed_profiles <= total_profiles)
);

create unique index profile_delete_one_active_idx on profile_delete_jobs (organization_id)
  where status in ('queued','running');
create index profile_delete_claim_idx on profile_delete_jobs (created_at, id)
  where status in ('queued','running');
create index profile_delete_history_idx on profile_delete_jobs (organization_id, created_at desc, id desc);

alter table profile_delete_jobs enable row level security;
alter table profile_delete_jobs force row level security;

create policy profile_delete_jobs_tenant on profile_delete_jobs to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy profile_delete_jobs_worker on profile_delete_jobs to ohb_worker using (true) with check (true);

grant select, insert, update on profile_delete_jobs to ohb_api;
grant select, insert, update, delete on profile_delete_jobs to ohb_worker;

comment on table profile_delete_jobs is 'Durable bounded Hermes host profile deletions; worker-owned, polled by the console.';

insert into schema_migrations(version) values ('0088_profile_delete_jobs') on conflict (version) do nothing;
commit;
