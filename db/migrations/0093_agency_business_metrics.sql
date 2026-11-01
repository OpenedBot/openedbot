begin;

-- The run ledger and business counters are shared by Overview, Usage and fleet.
-- Invoker functions retain the caller's tenant RLS. No host is contacted.
create function workspace_run_activity(p_org uuid, p_from timestamptz, p_until timestamptz)
returns table (id uuid, status text, observed_at timestamptz, input_tokens numeric, output_tokens numeric, total_tokens numeric)
language sql stable security invoker set search_path = pg_catalog, public
as $$
  select r.id, r.status, coalesce(r.ended_at, r.created_at),
    case when r.usage->>'inputTokens' ~ '^[0-9]+$' then (r.usage->>'inputTokens')::numeric end,
    case when r.usage->>'outputTokens' ~ '^[0-9]+$' then (r.usage->>'outputTokens')::numeric end,
    case when r.usage->>'totalTokens' ~ '^[0-9]+$' then (r.usage->>'totalTokens')::numeric end
  from public.runs r where r.organization_id = p_org
    and (p_from is null or coalesce(r.ended_at, r.created_at) >= p_from)
    and (p_until is null or coalesce(r.ended_at, r.created_at) < p_until);
$$;

create function workspace_business_metrics(p_org uuid, p_from timestamptz, p_until timestamptz, p_now timestamptz)
returns jsonb language sql stable security invoker set search_path = pg_catalog, public
as $$
  with activity as (select * from public.workspace_run_activity(p_org, p_from, p_until)),
  totals as (
    select count(*) as runs, count(*) filter (where status = 'completed') as completed,
      count(*) filter (where status = 'failed') as failed, coalesce(sum(total_tokens), 0) as tokens,
      count(*) filter (where total_tokens is not null) as measured,
      count(*) filter (where status in ('completed', 'failed') and total_tokens is null) as unknown
    from activity
  )
  select jsonb_build_object(
    'activeBots', (select count(*) from public.bots where organization_id = p_org and deleted_at is null and archived_at is null),
    'archivedBots', (select count(*) from public.bots where organization_id = p_org and deleted_at is null and archived_at is not null),
    'runsTotal', t.runs,
    'runsRunning', (select count(*) from public.runs where organization_id = p_org and status in ('starting','running','awaiting_approval')),
    'runsQueued', (select count(*) from public.runs where organization_id = p_org and status = 'queued'),
    'pendingApprovals', (select count(*) from public.approval_requests where organization_id = p_org
      and status = 'pending' and forward_state = 'pending' and selected_choice is null and expires_at > p_now),
    'completed', t.completed, 'failed', t.failed, 'tokens', t.tokens,
    'tokensMeasuredRuns', t.measured, 'tokensUnknownRuns', t.unknown,
    'successRate', case when t.completed + t.failed > 0 then round(100.0 * t.completed / (t.completed + t.failed), 2) end,
    'providerIncidents', (select count(*) from public.runtime_provider_incidents i
      join public.runtimes r on r.id = i.runtime_id and r.organization_id = i.organization_id
      where i.organization_id = p_org and i.until > p_now and r.is_active and r.revoked_at is null),
    'runtimeIncidents', (select count(*) from public.runtimes where organization_id = p_org and is_active and revoked_at is null
      and last_health_status is not null and last_health_status not in ('healthy','unknown'))
  ) from totals t;
$$;

-- This is the sole cross-tenant read for an agency portfolio. Unlike arbitrary
-- tenant settings, it requires the authenticated user, selected agency context,
-- and a live membership. The definer returns only authorized client metadata.
create function agency_authorized_clients(p_user uuid, p_agency uuid)
returns table (id uuid, name text, slug text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if nullif(current_setting('app.authenticating_user_id', true), '')::uuid is distinct from p_user
    or nullif(current_setting('app.organization_id', true), '')::uuid is distinct from p_agency
    or not exists (select 1 from public.memberships m join public.organizations a on a.id = m.organization_id
      where m.user_id = p_user and m.organization_id = p_agency and m.revoked_at is null
        and m.role in ('owner','admin','member') and a.kind = 'agency' and a.deleted_at is null)
  then raise insufficient_privilege using message = 'Agency access revoked'; end if;
  return query select c.id, c.name, c.slug from public.agency_grants g
    join public.organizations c on c.id = g.client_organization_id and c.kind = 'personal' and c.deleted_at is null
    where g.agency_organization_id = p_agency and g.revoked_at is null;
end;
$$;

create function agency_client_directory(p_user uuid, p_agency uuid, p_search text, p_offset integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare result jsonb;
begin
  if p_offset < 0 or p_offset > 250000 or p_limit < 1 or p_limit > 25 or length(p_search) > 200
    or p_offset is null or p_limit is null or p_search is null
  then raise invalid_parameter_value using message = 'Invalid agency page'; end if;
  with authorized as materialized (select * from public.agency_authorized_clients(p_user, p_agency)),
  filtered as (select * from authorized where p_search = '' or position(lower(p_search) in lower(name)) > 0),
  page as (select * from filtered order by lower(name), id limit p_limit offset p_offset)
  select jsonb_build_object('authorizedTotal', (select count(*) from authorized),
    'filteredTotal', (select count(*) from filtered),
    'workspaces', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug,
      'kind', 'personal', 'role', 'agency', 'viaAgencyIds', jsonb_build_array(p_agency)) order by lower(name), id) from page), '[]'::jsonb))
    into result;
  return result;
end;
$$;

-- Aggregates remain inside PostgreSQL. Page reads do not enumerate every
-- workspace of every agency on the account and never open N tenant connections.
create function agency_business_summary(p_user uuid, p_agency uuid, p_from timestamptz, p_until timestamptz, p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare result jsonb;
begin
  if p_from is null or p_until is null or p_now is null or p_until <= p_from or p_until - p_from > interval '90 days'
  then raise invalid_parameter_value using message = 'Invalid agency period'; end if;
  with metrics as materialized (
    select public.workspace_business_metrics(c.id, p_from, p_until, p_now) as value
    from public.agency_authorized_clients(p_user, p_agency) c
  )
  select jsonb_build_object(
    'state', case when coalesce(sum((value->>'tokensUnknownRuns')::numeric), 0) > 0 then 'partial' else 'complete' end,
    'coverage', jsonb_build_object(
      'measuredClients', count(*) filter (where (value->>'tokensUnknownRuns')::numeric = 0),
      'unknownClients', count(*) filter (where (value->>'tokensUnknownRuns')::numeric > 0), 'unreadableClients', 0),
    'totals', jsonb_build_object(
      'activeBots', coalesce(sum((value->>'activeBots')::numeric), 0),
      'archivedBots', coalesce(sum((value->>'archivedBots')::numeric), 0),
      'runsTotal', coalesce(sum((value->>'runsTotal')::numeric), 0),
      'runsRunning', coalesce(sum((value->>'runsRunning')::numeric), 0),
      'runsQueued', coalesce(sum((value->>'runsQueued')::numeric), 0),
      'pendingApprovals', coalesce(sum((value->>'pendingApprovals')::numeric), 0),
      'completed', coalesce(sum((value->>'completed')::numeric), 0),
      'failed', coalesce(sum((value->>'failed')::numeric), 0),
      'tokens', coalesce(sum((value->>'tokens')::numeric), 0),
      'tokensMeasuredRuns', coalesce(sum((value->>'tokensMeasuredRuns')::numeric), 0),
      'tokensUnknownRuns', coalesce(sum((value->>'tokensUnknownRuns')::numeric), 0),
      'providerIncidents', coalesce(sum((value->>'providerIncidents')::numeric), 0),
      'runtimeIncidents', coalesce(sum((value->>'runtimeIncidents')::numeric), 0),
      'successRate', case when coalesce(sum((value->>'completed')::numeric + (value->>'failed')::numeric), 0) > 0
        then round(100.0 * sum((value->>'completed')::numeric) / sum((value->>'completed')::numeric + (value->>'failed')::numeric), 2) end
    )) into result from metrics;
  return result;
end;
$$;

revoke all on function workspace_run_activity(uuid, timestamptz, timestamptz) from public;
revoke all on function workspace_business_metrics(uuid, timestamptz, timestamptz, timestamptz) from public;
revoke all on function agency_authorized_clients(uuid, uuid) from public;
revoke all on function agency_client_directory(uuid, uuid, text, integer, integer) from public;
revoke all on function agency_business_summary(uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
grant execute on function workspace_run_activity(uuid, timestamptz, timestamptz) to ohb_api;
grant execute on function workspace_business_metrics(uuid, timestamptz, timestamptz, timestamptz) to ohb_api;
grant execute on function agency_client_directory(uuid, uuid, text, integer, integer) to ohb_api;
grant execute on function agency_business_summary(uuid, uuid, timestamptz, timestamptz, timestamptz) to ohb_api;

create index membership_events_agency_timeline on membership_events (organization_id, subject_organization_id, occurred_at desc, id desc)
  where kind in ('agency_granted','agency_revoked');
create index approval_requests_pending_count on approval_requests (organization_id, expires_at)
  where status = 'pending' and forward_state = 'pending' and selected_choice is null;

insert into schema_migrations(version) values ('0093_agency_business_metrics');
commit;
