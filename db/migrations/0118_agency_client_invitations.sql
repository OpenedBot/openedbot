begin;
create table agency_client_invitations (
  id uuid primary key,
  agency_organization_id uuid not null references organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  token_hash text not null unique,
  invited_by_user_id uuid references users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'canceled', 'expired')),
  accepted_client_organization_id uuid references organizations(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index agency_client_invitations_pending_email
  on agency_client_invitations (agency_organization_id, email) where status = 'pending';
alter table agency_client_invitations enable row level security;
alter table agency_client_invitations force row level security;
create policy agency_client_invitations_api on agency_client_invitations to openedbot_api
  using (
    agency_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.agency_invitation_hash', true), '')
  ) with check (
    agency_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.agency_invitation_hash', true), '')
  );
grant select, insert, update on agency_client_invitations to openedbot_api;
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'waitlist_confirmation',
  'waitlist_access_granted',
  'waitlist_access_tier_changed',
  'waitlist_access_revoked',
  'staff_account_created',
  'staff_password_reset',
  'staff_login_code',
  'email_login_code',
  'provider_quota_reached',
  'account_purge_completed',
  'support_new_conversation',
  'runtime_link_down',
  'runtime_link_restored',
  'runtime_connector_outdated'
));
insert into schema_migrations(version) values ('0118_agency_client_invitations') on conflict do nothing;
commit;
