-- Tell the owner, once, that the connector of a runtime must be updated.
--
-- The link gateway already records the version a connector announces in
-- `hello` (`runtimes.link_agent`, 0055) and journals `agent_outdated` when it
-- is below `RUNTIME_CONNECTOR_MIN_VERSION`, but nobody was told. OHB never
-- updates a customer host: it can only ask the owner to run
-- `sudo edge-setup upgrade --yes`.
--
-- One row per (runtime, announced version, target version) is the dedupe
-- record: the gateway inserts it in the same transaction as the
-- `runtime_connector_outdated` e-mails, so a reconnect loop never writes a
-- second notice and a failed e-mail insert leaves no row behind. The worker
-- then fans the web push out to the owners' subscriptions, at most once.
--
-- `ohb_api` inserts under the tenant without reading back (same shape as
-- `email_outbox`, 0064): `on conflict do nothing` without a target and the
-- written row count say whether the notice is new. `ohb_worker` reads every
-- organization to drain the pending pushes, like `push_outbox` (0039):
-- exception declared in tests/integration/postgres-rls.sh.
begin;

create table runtime_connector_notices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  installed_version text not null,
  target_version text not null,
  created_at timestamptz not null default now(),
  push_status text not null default 'pending'
    constraint runtime_connector_notices_push_status_check
    check (push_status in ('pending', 'sending', 'sent', 'skipped')),
  push_processed_at timestamptz,
  unique (runtime_id, installed_version, target_version),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  check (length(installed_version) between 1 and 64),
  check (length(target_version) between 1 and 64)
);

create index runtime_connector_notices_pending_idx
  on runtime_connector_notices (created_at)
  where push_status = 'pending';

comment on table runtime_connector_notices is
  'Outdated connector notices: one per (runtime, announced version, target version). Dedupe record for the owner e-mail and web push; no token, no address.';

alter table runtime_connector_notices enable row level security;
alter table runtime_connector_notices force row level security;

create policy runtime_connector_notices_api on runtime_connector_notices
  for insert to ohb_api
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_connector_notices_worker on runtime_connector_notices to ohb_worker
  using (true) with check (true);

grant insert on runtime_connector_notices to ohb_api;
grant select, update on runtime_connector_notices to ohb_worker;

-- SQL twin of TRANSACTIONAL_EMAIL_KINDS (contracts/api/src/email-kinds.ts).
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created',
    'staff_password_reset',
    'support_new_conversation',
    'runtime_link_down',
    'runtime_connector_outdated'
  ));

insert into schema_migrations(version) values ('0101_runtime_connector_notices')
on conflict (version) do nothing;

commit;
