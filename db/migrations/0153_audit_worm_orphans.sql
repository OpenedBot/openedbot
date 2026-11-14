-- WORM objects that may outlive their transaction (step 6 order 0b).
--
-- The external anchor (the WORM bucket today) is written INSIDE the business
-- transaction. When that transaction then rolls back (a blocking anchor
-- failure, a later statement, the commit itself), the object may already sit
-- in the bucket while no `audit_chain` link points to it. A WORM object can
-- never be deleted, so nothing is deleted here either: the API marks the
-- object in its own transaction, and a reconciliation can compare the bucket
-- to `audit_chain` later.
--
-- `written`: `confirmed` when the anchor answered, `unknown` when it failed
-- or timed out (the write may or may not have landed). A later retry that
-- commits chains the same object key: an orphan row with a matching
-- `audit_chain` link is no longer an orphan, and the row stays as history.
--
-- Append-only, like `audit_chain`: no role may update a row, no application
-- role holds DELETE. Rows go only with their organization (FK cascade).
begin;

create table audit_worm_orphans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  kind text not null check (kind in ('runtime_anchor', 'audit_verdict')),
  object_key text not null check (char_length(object_key) between 1 and 256),
  anchor_id text not null check (char_length(anchor_id) between 1 and 128),
  written text not null check (written in ('confirmed', 'unknown')),
  reason text not null check (char_length(reason) between 1 and 512),
  detected_at timestamptz not null default now(),
  unique (runtime_id, object_key, anchor_id)
);

create index audit_worm_orphans_organization_idx on audit_worm_orphans (organization_id, detected_at);

comment on table audit_worm_orphans is
  'External anchor writes (WORM objects) whose business transaction rolled back: marked, never deleted. An orphan whose object key is later chained in audit_chain was retried successfully.';

create function audit_worm_orphans_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_worm_orphans is append-only' using errcode = '42501';
end;
$$;

create trigger audit_worm_orphans_no_update before update on audit_worm_orphans
  for each row execute function audit_worm_orphans_append_only();

alter table audit_worm_orphans enable row level security;
alter table audit_worm_orphans force row level security;
-- Same two contexts as audit_chain (0152): the tenant (verdict routes) and
-- the link credential (anchors received by the broker).
create policy audit_worm_orphans_api on audit_worm_orphans to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = audit_worm_orphans.runtime_id and r.organization_id = audit_worm_orphans.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = audit_worm_orphans.runtime_id and r.organization_id = audit_worm_orphans.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  );
grant select, insert on audit_worm_orphans to openedbot_api;

-- The worker reads the marks (reconciliation, tenant purge archive).
create policy audit_worm_orphans_worker on audit_worm_orphans for select to openedbot_worker using (true);
grant select on audit_worm_orphans to openedbot_worker;

insert into schema_migrations(version) values ('0153_audit_worm_orphans')
on conflict (version) do nothing;

commit;
