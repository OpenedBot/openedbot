-- Which edge-setup release announcement a member has already closed.
--
-- The console shows the owner a dialog when the host's connector is behind
-- the latest public edge-setup release (notes, `sudo edge-setup upgrade
-- --yes`, `auto-upgrade enable`). An "update available" dialog is shown once
-- per release and per member, on every device: one row per (organization,
-- member, version) is that receipt. A required update (below the minimum)
-- ignores it and comes back each session.
--
-- No secret, no text: the version only. The member reads and writes their own
-- rows under the tenant, behind `app.authenticating_user_id` like
-- push_subscriptions (0039); the worker never touches it. Revoking the
-- membership or deleting the organization removes the rows.
begin;

create table runtime_connector_release_seen (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  version text not null,
  seen_at timestamptz not null default now(),
  primary key (organization_id, user_id, version),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  check (version ~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
);

comment on table runtime_connector_release_seen is
  'Edge-setup release announcements a member closed: one row per (organization, member, version). Version only, no text.';

alter table runtime_connector_release_seen enable row level security;
alter table runtime_connector_release_seen force row level security;

create policy runtime_connector_release_seen_member on runtime_connector_release_seen to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  );

grant select, insert on runtime_connector_release_seen to ohb_api;

insert into schema_migrations(version) values ('0109_connector_release_seen')
on conflict (version) do nothing;

commit;
