-- An account has one workspace, reached through its own membership only.
--
-- What goes: grant-derived access to another organization (`agency_grants`),
-- the client invitations (`agency_client_invitations`), the per-account
-- workspace preferences (`account_preferences`), the three directory functions
-- of 0093, their partial journal index, the two product switches that opened
-- the feature, and every stored value that only that feature could write
-- (organization kind, journal kinds, actor kinds, e-mail kinds).
--
-- Rolling deploy: `infra/scripts/prod-migrate.sh` applies this file BEFORE the
-- new images are promoted, and the previous release stays available for a
-- rollback. That release runs without plug-in, so it never reaches what is
-- removed here, and every function it calls keeps its signature:
-- `workspace_access(uuid, uuid)` still returns (role, kind, via_agency_ids),
-- now from the direct membership alone. What that release still writes or
-- reads stays until the next migration: `organizations.kind`, the four
-- `*_agency_organization_id` actor columns, `membership_events.subject_organization_id`
-- and `organization_member_invitations` (its preview route is anonymous).
--
-- Nothing is converted and no user data is deleted: the guard refuses to run
-- while any row still depends on what goes.
begin;

-- 1. Guard (same shape as 0119): refuse rather than delete someone's data.
do $guard$
begin
  if exists (select 1 from organizations where kind <> 'personal') then
    raise exception 'single-workspace accounts: an organization of another kind than personal exists; move its bots and members to personal workspaces and delete it, then migrate again';
  end if;
  if exists (select 1 from agency_grants) then
    raise exception 'single-workspace accounts: agency_grants is not empty; revoke and export those grants explicitly, delete the rows, then migrate again';
  end if;
  if exists (select 1 from agency_client_invitations) then
    raise exception 'single-workspace accounts: agency_client_invitations is not empty; export and delete those invitations explicitly, then migrate again';
  end if;
  if exists (select 1 from account_preferences) then
    raise exception 'single-workspace accounts: account_preferences is not empty; export and delete those rows explicitly, then migrate again';
  end if;
  if exists (
    select 1 from membership_events
     where kind in ('agency_granted', 'agency_revoked') or role = 'agency' or subject_organization_id is not null
  ) then
    raise exception 'single-workspace accounts: membership_events holds grant events (agency kind, role or subject organization); export and delete them explicitly, then migrate again';
  end if;
  if exists (select 1 from approval_requests where decided_by_kind = 'agency')
     or exists (select 1 from bot_permission_grants where created_by_kind = 'agency' or revoked_by_kind = 'agency')
     or exists (select 1 from bot_permission_rules where created_by_kind = 'agency')
     or exists (select 1 from bot_permission_tool_policies where updated_by_kind = 'agency')
     or exists (select 1 from runtime_permission_settings where updated_by_kind = 'agency') then
    raise exception 'single-workspace accounts: an approval or permission row was written by a delegated (agency) actor; reassign it to a member explicitly, then migrate again';
  end if;
  if exists (
    select 1 from email_outbox
     where kind in ('agency_client_invitation', 'agency_client_response', 'organization_member_invitation')
       and status in ('pending', 'sending')
  ) then
    raise exception 'single-workspace accounts: an invitation e-mail is still queued; let the worker deliver or fail it, then migrate again';
  end if;
  if exists (
    select 1 from email_outbox
     where kind in ('agency_client_invitation', 'agency_client_response', 'organization_member_invitation')
  ) then
    raise exception 'single-workspace accounts: email_outbox keeps delivered invitation e-mails; export and delete those rows explicitly, then migrate again';
  end if;
end;
$guard$;

-- 2. Account erasure (latest body: 0185) without `account_preferences`.
-- PL/pgSQL resolves table names at run time: redefined before the drop.
-- Users are never deleted: an action they took in another workspace can still
-- reference them, so their identity is pseudonymized instead.
create or replace function public.erase_account_user(p_user_id uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.users where id = p_user_id for update;
  if not found then return 'absent'; end if;
  if exists (select 1 from public.memberships where user_id = p_user_id and revoked_at is null)
    or exists (select 1 from public.account_deletions where user_id = p_user_id) then
    return 'kept';
  end if;
  delete from public.email_login_codes where email = (select lower(email) from public.users where id = p_user_id);
  update public.users set email = 'erased+' || p_user_id::text || '@erased.invalid',
    password_hash = null, google_subject = null, display_name = null, updated_at = now()
    where id = p_user_id;
  delete from public.sessions where user_id = p_user_id;
  delete from public.native_auth_codes where user_id = p_user_id;
  delete from public.mobile_connect_tickets where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.apns_devices where user_id = p_user_id;
  return 'pseudonymized';
end;
$$;
revoke all on function public.erase_account_user(uuid) from public;
grant execute on function public.erase_account_user(uuid) to openedbot_worker;

-- 3. Workspace access (latest body: 0119): the direct, live membership only.
-- Same signature and columns, because the previous release selects
-- (role, kind, via_agency_ids) on every authenticated request; the list of
-- delegating organizations is always empty.
create or replace function workspace_access(p_user uuid, p_org uuid)
returns table (role text, kind text, via_agency_ids uuid[])
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with target as (
    select o.id, o.kind from public.organizations o
     where o.id = p_org and o.deleted_at is null
  )
  select (select m.role from public.memberships m
           where m.organization_id = t.id and m.user_id = p_user and m.revoked_at is null
           limit 1),
         t.kind,
         '{}'::uuid[]
    from target t;
$$;
revoke all on function workspace_access(uuid, uuid) from public;
grant execute on function workspace_access(uuid, uuid) to openedbot_api;

-- 4. Backoffice organization detail (latest body: 0086). `kind` stays and
-- `agencyGrants` is always empty: a backoffice plug-in built against the
-- previous payload keeps parsing it.
create or replace function staff_get_organization(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  payload jsonb;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', o.id,
    'slug', o.slug,
    'name', o.name,
    'kind', o.kind,
    'createdAt', o.created_at,
    'deletedAt', o.deleted_at,
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'userId', u.id,
          'email', u.email,
          'displayName', u.display_name,
          'role', m.role
        )
        order by m.created_at
      )
      from public.memberships m
      join public.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'::jsonb),
    'agencyGrants', '[]'::jsonb,
    'subscription', (
      select jsonb_build_object(
        'status', s.status,
        'runtimeLimit', s.runtime_limit,
        'memberLimit', s.member_limit,
        'concurrentRunLimit', s.concurrent_run_limit,
        'attachmentQuotaBytes', s.attachment_quota_bytes,
        'currentPeriodEnd', s.current_period_end,
        'stripeCustomerId', s.stripe_customer_id
      )
      from public.subscriptions s
      where s.organization_id = o.id
    ),
    'runtimes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'name', r.name,
          'endpointHost', (regexp_match(r.endpoint, '^https?://([^/?#]+)'))[1],
          'health', r.last_health_status,
          'lastCheckedAt', r.last_probed_at
        )
        order by r.created_at
      )
      from public.runtimes r
      where r.organization_id = o.id
    ), '[]'::jsonb),
    'tenantDeletion', (
      select jsonb_build_object(
        'reason', d.reason,
        'requestedAt', d.requested_at,
        'purgeAfter', d.purge_after,
        'startedAt', d.started_at,
        'completedAt', d.completed_at
      )
      from public.tenant_deletions d
      where d.organization_id = o.id
    )
  )
  into payload
  from public.organizations o
  where o.id = p_id;

  return payload;
end;
$$;
revoke all on function staff_get_organization(uuid) from public;
grant execute on function staff_get_organization(uuid) to openedbot_api;

-- Functions must belong to the migration role, never an application role (0185).
do $owner$
declare migrator name;
begin
  select tableowner into migrator from pg_catalog.pg_tables where schemaname = 'public' and tablename = 'users';
  if migrator in ('openedbot_api', 'openedbot_worker', 'openedbot_staff') then raise exception 'Migration owner required'; end if;
  execute format('alter function public.erase_account_user(uuid) owner to %I', migrator);
end;
$owner$;

-- 5. The directory functions of 0093, callers first. `workspace_run_activity`
-- and `workspace_business_metrics` stay: Overview and Usage read them.
drop function agency_business_summary(uuid, uuid, timestamptz, timestamptz, timestamptz);
drop function agency_client_directory(uuid, uuid, text, integer, integer);
drop function agency_authorized_clients(uuid, uuid);

-- 6. Partial index over the grant events only (0093); the guard proved it empty.
drop index membership_events_agency_timeline;

-- 7. The tables. No foreign key points at them.
drop table agency_client_invitations;
drop table agency_grants;
drop table account_preferences;

-- 8. The switches that opened the feature. A missing row reads as off.
delete from product_features where feature_key in ('agency_workspaces', 'agency_billing');

-- 9. Only personal organizations remain, and only they can be created.
alter table organizations drop constraint organizations_kind_check;
alter table organizations add constraint organizations_kind_check check (kind = 'personal');

-- 10. Stored values only the removed feature could write.
-- Journal (latest list: 0120) without the grant events.
alter table membership_events drop constraint membership_events_kind_check;
alter table membership_events add constraint membership_events_kind_check
  check (kind in (
    'invited',
    'accepted',
    'role_changed',
    'revoked',
    'member_invited',
    'member_joined',
    'member_invitation_canceled'
  ));

-- E-mails (latest list: 0189) without the two client e-mails and the member invitation.
alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'staff_account_created','staff_password_reset','staff_login_code','email_login_code',
  'provider_quota_reached','account_purge_completed','account_closure_notice',
  'support_new_conversation','runtime_link_down','runtime_link_restored','runtime_connector_outdated',
  'workflow_approval','workflow_completed','workflow_failed'
));

-- Actors (0138, 0140, 0141, 0145): a member, or the policy for approvals.
alter table approval_requests drop constraint approval_requests_decided_by_kind_check;
alter table approval_requests add constraint approval_requests_decided_by_kind_check
  check (decided_by_kind is null or decided_by_kind in ('member', 'policy'));
alter table bot_permission_grants drop constraint bot_permission_grants_created_by_kind_check;
alter table bot_permission_grants add constraint bot_permission_grants_created_by_kind_check
  check (created_by_kind = 'member');
alter table bot_permission_grants drop constraint bot_permission_grants_revoked_by_kind_check;
alter table bot_permission_grants add constraint bot_permission_grants_revoked_by_kind_check
  check (revoked_by_kind is null or revoked_by_kind = 'member');
alter table bot_permission_rules drop constraint bot_permission_rules_created_by_kind_check;
alter table bot_permission_rules add constraint bot_permission_rules_created_by_kind_check
  check (created_by_kind = 'member');
alter table bot_permission_tool_policies drop constraint bot_permission_tool_policies_actor_kind_check;
alter table bot_permission_tool_policies add constraint bot_permission_tool_policies_actor_kind_check
  check (updated_by_kind = 'member');
alter table runtime_permission_settings drop constraint runtime_permission_settings_updated_by_kind_check;
alter table runtime_permission_settings add constraint runtime_permission_settings_updated_by_kind_check
  check (updated_by_kind = 'member');

insert into schema_migrations(version) values ('0190_single_workspace_accounts') on conflict do nothing;
commit;
