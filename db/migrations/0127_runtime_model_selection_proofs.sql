begin;
create table runtime_model_selection_proofs (
  runtime_id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text,
  model text,
  reasoning_effort text,
  check ((provider is null) = (model is null)),
  status text not null default 'queued' check (status in ('queued','running','failed')),
  request_generation bigint not null default 1,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  error jsonb,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);
create index runtime_model_selection_proof_claim_idx on runtime_model_selection_proofs (next_attempt_at)
  where status in ('queued','running');
alter table runtime_model_selection_proofs enable row level security;
alter table runtime_model_selection_proofs force row level security;
create policy runtime_model_selection_proofs_tenant on runtime_model_selection_proofs to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_model_selection_proofs_worker on runtime_model_selection_proofs to ohb_worker using (true) with check (true);
grant select, insert, update, delete on runtime_model_selection_proofs to ohb_api;
grant select, insert, update, delete on runtime_model_selection_proofs to ohb_worker;
comment on table runtime_model_selection_proofs is 'Pending runtime model selections awaiting a worker canary proof.';
insert into schema_migrations(version) values ('0127_runtime_model_selection_proofs') on conflict (version) do nothing;
commit;
