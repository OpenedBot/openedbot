-- Member invitations come back to the open core: the owner or an admin of a
-- workspace invites someone into it, free, with no member limit on one's own
-- instance. One account still has one workspace (0190): an invitation targets
-- the inviter's personal workspace, and an account that already belongs to
-- another one is refused at acceptance by the API, not by the schema.
--
-- 0190 kept everything the feature stores: `organization_member_invitations`
-- (table, pending-email index, RLS policy opened by the tenant or by the
-- invitation hash, API grants) and the three `membership_events` kinds. Only
-- the invitation e-mail left the `email_outbox` kind list; it comes back here.
--
-- Rolling deploy: applied before the new images are promoted. The previous
-- release never writes this kind, so widening the list is invisible to it.
-- Nothing is converted or deleted.
begin;

-- 1. Guard: what 0190 kept must still be there, or the feature would run on a
-- half-dropped schema. Refuse rather than recreate something by guesswork.
do $guard$
begin
  if to_regclass('public.organization_member_invitations') is null then
    raise exception 'member invitations: organization_member_invitations is missing; restore it from 0120 before migrating';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'organization_member_invitations'
       and policyname = 'organization_member_invitations_api'
  ) then
    raise exception 'member invitations: the RLS policy organization_member_invitations_api is missing; restore it from 0120 before migrating';
  end if;
  if not exists (
    select 1 from pg_class c
     where c.oid = 'public.organization_member_invitations'::regclass
       and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'member invitations: row level security is not forced on organization_member_invitations';
  end if;
  if not has_table_privilege('openedbot_api', 'public.organization_member_invitations', 'select, insert, update') then
    raise exception 'member invitations: openedbot_api lost its grants on organization_member_invitations';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'membership_events_kind_check'
       and pg_get_constraintdef(oid) like '%member_invited%'
       and pg_get_constraintdef(oid) like '%member_joined%'
       and pg_get_constraintdef(oid) like '%member_invitation_canceled%'
  ) then
    raise exception 'member invitations: membership_events no longer accepts the invitation kinds';
  end if;
end;
$guard$;

-- 2. E-mails (latest list: 0190) with the member invitation back.
alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'organization_member_invitation',
  'staff_account_created','staff_password_reset','staff_login_code','email_login_code',
  'provider_quota_reached','account_purge_completed','account_closure_notice',
  'support_new_conversation','runtime_link_down','runtime_link_restored','runtime_connector_outdated',
  'workflow_approval','workflow_completed','workflow_failed'
));

insert into schema_migrations(version) values ('0191_member_invitations_return') on conflict do nothing;
commit;
