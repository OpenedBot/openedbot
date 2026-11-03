-- Local hash chain of the creation audit (step 5, AuditAnchor).
--
-- Every anchor received from a connector and every verdict rendered is
-- appended here, in the same transaction as the business write, as one
-- link of a per-runtime chain: hash = sha256(canonical {v, seq, prev, kind,
-- payloadSha256}). The chain is the core's own anchoring, in solo mode as
-- in pro; an external anchor (the WORM bucket today, the `audit` plug-in
-- later) is called after it, in the same transaction.
--
-- Append-only: no role may update a row (trigger, owner included), and no
-- application role holds DELETE. Rows go only with their organization (FK
-- cascade, tenant purge); the `audit` plug-in archives and pseudonymizes the
-- retained ones first (`onTenantDeleting`). No FK to `runtimes`: deleting a
-- runtime keeps its chain.
begin;

create table audit_chain (
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  seq bigint not null check (seq >= 1),
  kind text not null check (kind in ('runtime_anchor', 'audit_verdict')),
  object_key text not null check (char_length(object_key) between 1 and 256),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  prev_hash text check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (runtime_id, seq),
  unique (runtime_id, object_key),
  check ((seq = 1) = (prev_hash is null))
);

create index audit_chain_organization_idx on audit_chain (organization_id, runtime_id, seq);

comment on table audit_chain is
  'Local hash chain of the creation audit, one chain per runtime: each received anchor (runtime_anchor) and each verdict (audit_verdict), appended in the business transaction. Append-only; verified by GET /api/runtimes/:id/creation-audit/local-chain. Goes with its organization only.';
comment on column audit_chain.hash is
  'sha256 of the canonical JSON {v: 1, seq, prev, kind, payloadSha256}: identifiers are not hashed directly, so pseudonymized archives still verify.';

create function audit_chain_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_chain is append-only' using errcode = '42501';
end;
$$;

create trigger audit_chain_no_update before update on audit_chain
  for each row execute function audit_chain_append_only();

alter table audit_chain enable row level security;
alter table audit_chain force row level security;
-- Same two contexts as runtime_audit_anchors (0052): the tenant (session
-- routes) and the link credential (broker writes).
create policy audit_chain_api on audit_chain to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = audit_chain.runtime_id and r.organization_id = audit_chain.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = audit_chain.runtime_id and r.organization_id = audit_chain.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  );
grant select, insert on audit_chain to ohb_api;

-- The worker reads the chain in the tenant purge (plug-in onTenantDeleting).
create policy audit_chain_worker on audit_chain for select to ohb_worker using (true);
grant select on audit_chain to ohb_worker;

insert into schema_migrations(version) values ('0152_audit_local_chain')
on conflict (version) do nothing;

commit;
