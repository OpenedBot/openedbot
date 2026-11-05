begin;

alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'member', 'agency'));
alter table memberships add column revoked_at timestamptz;

alter table organization_invitations drop constraint organization_invitations_role_check;
alter table organization_invitations add constraint organization_invitations_role_check
  check (role in ('admin', 'member', 'agency'));
alter table organization_invitations add column accepted_by_user_id uuid references users(id) on delete set null;

-- Web authentication survives losing one workspace. Native and assistance
-- sessions remain tenant-bound in the authentication middleware.
alter table sessions drop constraint sessions_organization_id_user_id_fkey;
alter table sessions alter column organization_id drop not null;
alter table sessions add constraint sessions_user_fk
  foreign key (user_id) references users(id) on delete cascade;
alter table sessions add constraint sessions_initial_organization_fk
  foreign key (organization_id) references organizations(id) on delete set null;

create table account_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  agency_enabled boolean not null default false,
  home_mode text not null default 'personal' check (home_mode in ('personal', 'agency')),
  updated_at timestamptz not null default now(),
  check (home_mode <> 'agency' or agency_enabled)
);
alter table account_preferences enable row level security;
alter table account_preferences force row level security;
create policy account_preferences_user on account_preferences to openedbot_api
  using (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid);
grant select, insert, update on account_preferences to openedbot_api;

create table membership_events (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid not null,
  subject_user_id uuid,
  kind text not null check (kind in ('invited', 'accepted', 'role_changed', 'revoked')),
  role text not null,
  occurred_at timestamptz not null default now()
);
alter table membership_events enable row level security;
alter table membership_events force row level security;
create policy membership_events_tenant on membership_events to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert on membership_events to openedbot_api;
create index membership_events_timeline on membership_events (organization_id, occurred_at desc);

insert into schema_migrations(version) values ('0083_agency_workspaces') on conflict (version) do nothing;
commit;
