begin;

create table organization_member_invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by_user_id uuid references users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'canceled', 'expired')),
  accepted_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index organization_member_invitations_pending_email
  on organization_member_invitations (organization_id, email) where status = 'pending';

alter table organization_member_invitations enable row level security;
alter table organization_member_invitations force row level security;
create policy organization_member_invitations_api on organization_member_invitations to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.member_invitation_hash', true), '')
  ) with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.member_invitation_hash', true), '')
  );
grant select, insert, update on organization_member_invitations to ohb_api;

alter table membership_events drop constraint if exists membership_events_kind_check;
alter table membership_events add constraint membership_events_kind_check
  check (kind in (
    'invited',
    'accepted',
    'role_changed',
    'revoked',
    'agency_granted',
    'agency_revoked',
    'member_invited',
    'member_joined',
    'member_invitation_canceled'
  ));

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'organization_member_invitation',
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

insert into schema_migrations(version) values ('0120_organization_member_invitations') on conflict do nothing;
commit;
