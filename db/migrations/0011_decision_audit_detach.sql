begin;

-- A decision is an immutable audit record. Deleting the bot that caused it
-- removes the live thread, run and approval request, but must not remove or
-- block the signed decision. The immutable envelope keeps the identifiers
-- that were part of the hash chain; these nullable columns are only live
-- navigation pointers.
alter table decisions
  drop constraint decisions_organization_id_thread_id_fkey,
  drop constraint decisions_organization_id_run_id_fkey,
  drop constraint decisions_organization_id_approval_request_id_fkey,
  alter column thread_id drop not null,
  alter column run_id drop not null;

-- Targeted SET NULL preserves the tenant discriminator on composite foreign
-- keys, so RLS remains enforceable after the referenced live data is gone.
alter table decisions
  add constraint decisions_organization_id_thread_id_fkey
    foreign key (organization_id, thread_id)
    references threads(organization_id, id)
    on delete set null (thread_id),
  add constraint decisions_organization_id_run_id_fkey
    foreign key (organization_id, run_id)
    references runs(organization_id, id)
    on delete set null (run_id),
  add constraint decisions_organization_id_approval_request_id_fkey
    foreign key (organization_id, approval_request_id)
    references approval_requests(organization_id, id)
    on delete set null (approval_request_id);

comment on column decisions.thread_id is
  'Nullable live pointer; the signed envelope retains the historical thread identifier.';
comment on column decisions.run_id is
  'Nullable live pointer; the signed envelope retains the historical run identifier.';
comment on column decisions.approval_request_id is
  'Nullable live pointer; the signed envelope retains the historical approval identifier.';

insert into schema_migrations(version) values ('0011_decision_audit_detach')
on conflict (version) do nothing;

commit;
