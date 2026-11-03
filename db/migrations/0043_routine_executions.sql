begin;

-- OHB-21 : historique d'execution des routines. Chaque tick laisse une ligne
-- relisible : tir nominal, rattrapage, report de fil occupe, abandon au
-- plafond, salon vide. Les recus (`GET /api/routines/receipts`) restent la
-- vue workflow ; cette table est l'audit des issues qui ne creent pas de
-- run (report, abandon, GROUP_EMPTY).

create table routine_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  routine_id uuid not null,
  outcome text not null check (outcome in (
    'fired', 'catch_up', 'deferred', 'abandoned', 'group_empty'
  )),
  trigger text not null check (trigger in ('scheduled', 'manual')),
  missed_count integer not null default 0 check (missed_count >= 0),
  busy_retries integer check (busy_retries is null or busy_retries >= 0),
  error_code text,
  error_message text,
  workflow_id uuid,
  run_id uuid,
  thread_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, routine_id)
    references routines(organization_id, id) on delete cascade,
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete set null,
  foreign key (organization_id, run_id)
    references runs(organization_id, id) on delete set null,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete set null,
  check (error_code is null or length(error_code) between 1 and 80),
  check (error_message is null or length(error_message) between 1 and 500)
);

create index routine_executions_routine_idx
  on routine_executions (organization_id, routine_id, created_at desc, id desc);

comment on table routine_executions is
  'Historique d''un tick de routine : tir, rattrapage, report de fil occupe, abandon au plafond, salon vide. RLS tenant ; le worker ecrit, l''API lit.';

alter table routine_executions enable row level security;
alter table routine_executions force row level security;

create policy routine_executions_tenant on routine_executions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy routine_executions_worker on routine_executions to ohb_worker
  using (true) with check (true);

grant select, insert on routine_executions to ohb_api;
grant select, insert, update, delete on routine_executions to ohb_worker;

insert into schema_migrations(version) values ('0043_routine_executions')
on conflict (version) do nothing;

commit;
