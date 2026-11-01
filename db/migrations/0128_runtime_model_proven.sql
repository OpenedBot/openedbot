begin;
create table runtime_model_proven (
  organization_id uuid not null,
  runtime_id uuid not null,
  provider text not null,
  model text not null,
  proven_at timestamptz not null default now(),
  primary key (runtime_id, provider, model),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);
alter table runtime_model_proven enable row level security;
alter table runtime_model_proven force row level security;
create policy runtime_model_proven_tenant on runtime_model_proven to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_model_proven_worker on runtime_model_proven to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on runtime_model_proven to ohb_api;
grant select, insert, update, delete on runtime_model_proven to ohb_worker;
comment on table runtime_model_proven is 'Runtime model selections that completed a successful inference proof.';
insert into schema_migrations(version) values ('0128_runtime_model_proven') on conflict (version) do nothing;
commit;
