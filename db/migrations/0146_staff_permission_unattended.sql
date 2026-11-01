begin;

-- PERM2-11 after PERM2-9: the staff stage filter of
-- `staff_permission_decisions` (0143) knows the `unattended` stage (0144),
-- a gate refused because nobody attends the routine run. Same body, same
-- guard, same grants; only the list of accepted stages grows.

create or replace function staff_permission_decisions(
  p_stage text default null,
  p_limit int default 100,
  p_before timestamptz default null
)
returns table (
  id uuid,
  created_at timestamptz,
  resolved_at timestamptz,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  bot_id uuid,
  bot_name text,
  pipeline text,
  gate_kind text,
  tool_key text,
  decision_state text,
  decision_stage text,
  decided_by text,
  outcome text,
  resolved_by_policy text,
  resolver_user_id uuid,
  resolver_email text,
  resolver_name text,
  permission_revision_seen bigint,
  detail jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  if p_stage is not null and p_stage not in (
    'legacy', 'forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human', 'unattended'
  ) then
    raise exception 'unknown permission decision stage' using errcode = '22023';
  end if;
  return query
    select a.id, a.created_at, a.resolved_at,
           o.id, o.name, o.slug,
           b.id, b.name,
           case when a.decision_state is null then 'legacy' else 'v2' end,
           a.gate_kind, a.tool_key, a.decision_state, a.decision_stage,
           case
             when a.decision_state is not null then a.decided_by_kind
             when a.resolved_by_policy is not null then 'policy'
             when a.resolved_by is not null then 'member'
             else null
           end,
           case
             when a.status = 'expired' then 'expired'
             when a.selected_choice is not null then a.selected_choice
             when a.decision_state = 'reviewing' then 'reviewing'
             else 'pending'
           end,
           a.resolved_by_policy,
           u.id, u.email, u.display_name,
           a.permission_revision_seen,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', a.decision_detail -> 'reason',
             'effectiveMode', a.decision_detail -> 'effectiveMode',
             'always', a.decision_detail -> 'always',
             'grantError', a.decision_detail -> 'grantError',
             'humanOverridden', a.decision_detail -> 'humanOverridden',
             'redecided', a.decision_detail -> 'redecided',
             'policyChanged', a.decision_detail -> 'policyChanged',
             'durationMs', a.decision_detail -> 'durationMs'
           ))
      from public.approval_requests a
      join public.organizations o on o.id = a.organization_id
      left join public.runs r on r.organization_id = a.organization_id and r.id = a.run_id
      left join public.threads t on t.organization_id = a.organization_id and t.id = a.thread_id
      left join public.bots b on b.organization_id = a.organization_id and b.id = coalesce(r.bot_id, t.bot_id)
      left join public.users u on u.id = a.resolved_by
     where o.deleted_at is null
       and (p_before is null or a.created_at < p_before)
       and (
         p_stage is null
         or (p_stage = 'legacy' and a.decision_state is null)
         or (p_stage <> 'legacy' and a.decision_stage = p_stage)
       )
     order by a.created_at desc, a.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

insert into schema_migrations(version) values ('0146_staff_permission_unattended');
commit;
