begin;
alter table runtime_model_selection_proofs
  add column request_id uuid not null default gen_random_uuid(),
  add column lease_token uuid;
insert into schema_migrations(version) values ('0129_runtime_model_selection_proof_fencing') on conflict (version) do nothing;
commit;
