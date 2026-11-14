begin;

-- Staff backoffice. Separate from tenant memberships: an org owner is not
-- staff, and a staff session never sets app.organization_id.

create table staff_users (
  id uuid primary key,
  email text not null,
  password_hash text not null,
  display_name text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index staff_users_email_unique_idx on staff_users (lower(email));

create table staff_sessions (
  id uuid primary key,
  staff_user_id uuid not null references staff_users(id) on delete cascade,
  session_token_hash text not null unique,
  csrf_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip inet,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index staff_sessions_user_idx on staff_sessions (staff_user_id, created_at desc);

alter table staff_users enable row level security;
alter table staff_users force row level security;
alter table staff_sessions enable row level security;
alter table staff_sessions force row level security;

-- Login looks up by email through app.staff_email; every other access is the
-- live staff user id. Inserts (seed, session creation) go through staff_user_id.
create policy staff_users_api on staff_users to openedbot_api
  using (
    id = nullif(current_setting('app.staff_user_id', true), '')::uuid
    or lower(email) = nullif(current_setting('app.staff_email', true), '')
  )
  with check (
    id = nullif(current_setting('app.staff_user_id', true), '')::uuid
  );

create policy staff_sessions_api on staff_sessions to openedbot_api
  using (
    session_token_hash = nullif(current_setting('app.staff_session_hash', true), '')
    or staff_user_id = nullif(current_setting('app.staff_user_id', true), '')::uuid
  )
  with check (
    session_token_hash = nullif(current_setting('app.staff_session_hash', true), '')
    or staff_user_id = nullif(current_setting('app.staff_user_id', true), '')::uuid
  );

grant select, insert, update, delete on staff_users, staff_sessions to openedbot_api;

-- Cross-tenant reads. openedbot_api still cannot SELECT other orgs with a tenant GUC;
-- these definers abort unless app.staff_user_id is a live (non-disabled) staff user.
create or replace function staff_list_organizations()
returns table (
  id uuid,
  slug text,
  name text,
  created_at timestamptz,
  deleted_at timestamptz,
  member_count bigint,
  bot_count bigint,
  subscription_status text,
  runtime_health text,
  last_checked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
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

  return query
  select
    o.id,
    o.slug,
    o.name,
    o.created_at,
    o.deleted_at,
    (select count(*) from public.memberships m where m.organization_id = o.id),
    (select count(*) from public.bots b where b.organization_id = o.id),
    s.status,
    r.last_health_status,
    r.last_probed_at
  from public.organizations o
  left join public.subscriptions s on s.organization_id = o.id
  left join public.runtimes r on r.organization_id = o.id and r.is_active
  order by o.created_at asc;
end;
$$;

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
    'createdAt', o.created_at,
    'deletedAt', o.deleted_at,
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
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

create or replace function staff_operational_metrics()
returns table (
  run_status_counts jsonb,
  run_external_state_counts jsonb,
  workflow_status_counts jsonb,
  queued_runs bigint,
  oldest_queued_seconds double precision,
  needs_review_runs bigint,
  oldest_unknown_seconds double precision,
  active_workflows bigint,
  unknown_workflows bigint,
  overdue_workflows bigint,
  pending_approvals bigint,
  expired_pending_approvals bigint,
  oldest_pending_approval_seconds double precision,
  relaying_runs bigint,
  oldest_relaying_seconds double precision,
  active_run_leases bigint,
  expired_run_leases bigint,
  missing_run_leases bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
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

  return query select * from public.internal_operational_metrics();
end;
$$;

revoke all on function staff_list_organizations() from public;
revoke all on function staff_get_organization(uuid) from public;
revoke all on function staff_operational_metrics() from public;
grant execute on function staff_list_organizations() to openedbot_api;
grant execute on function staff_get_organization(uuid) to openedbot_api;
grant execute on function staff_operational_metrics() to openedbot_api;

insert into schema_migrations(version) values ('0023_staff')
on conflict (version) do nothing;

commit;
