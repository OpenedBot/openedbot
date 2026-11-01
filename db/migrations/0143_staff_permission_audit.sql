begin;

-- PERM2-11 (DEV-OHB-262): the staff audit of permission decisions.
--
-- Read-only, cross-tenant, staff only. Same guard as
-- `staff_runtime_connectors` (0102): every function is `security definer` and
-- opens nothing without a live `app.staff_user_id`, which only
-- `withStaffUser` sets. No table, no write, no new privilege for the worker.
--
-- What crosses: who or what answered a gate (`decided_by`), at which stage of
-- the pipeline (`decision_stage`), its outcome and the stable reason CODES of
-- `decision_detail`. What never crosses: the command, the gate arguments, the
-- description, and `decision_detail.reviewerReason` (free model text that may
-- quote the gate). The detail is rebuilt here from a closed list of keys, so a
-- key added later to `decision_detail` stays inside until it is listed.
--
-- `decided_by` reads the pipeline trace when there is one (`decided_by_kind`)
-- and, on a `legacy` gate, the two columns that said it before 0138:
-- `resolved_by_policy` (a policy answered) or `resolved_by` (a person did).

create or replace function staff_permission_guard()
returns void
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
  if staff_id is null or not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
end;
$$;

revoke all on function staff_permission_guard() from public;

-- Gates of the last `p_days` days (1 to 90), counted by pipeline, stage,
-- decider, outcome and gate kind. `outcome` is the answer when there is one,
-- otherwise where the gate stands (`reviewing`, `pending`, `expired`).
create or replace function staff_permission_decision_stats(p_days int default 7)
returns table (
  pipeline text,
  decision_stage text,
  decided_by text,
  outcome text,
  gate_kind text,
  gates bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  return query
    select case when a.decision_state is null then 'legacy' else 'v2' end,
           a.decision_stage,
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
           a.gate_kind,
           count(*)
      from public.approval_requests a
      join public.organizations o on o.id = a.organization_id
     where o.deleted_at is null
       and a.created_at >= now() - (greatest(1, least(coalesce(p_days, 7), 90)) * interval '1 day')
     group by 1, 2, 3, 4, 5
     order by 6 desc, 1, 2, 3, 4, 5;
end;
$$;

comment on function staff_permission_decision_stats(int) is
  'PERM2-11: gates of the last p_days days (1 to 90) counted by pipeline, stage, decider, outcome and gate kind. Staff read only, no gate text.';

revoke all on function staff_permission_decision_stats(int) from public;
grant execute on function staff_permission_decision_stats(int) to ohb_api;

-- The latest gates, newest first, one stage at a time or all of them.
-- `p_stage` is a pipeline stage, `legacy` for gates without the pipeline
-- trace, or null for every gate. `p_before` pages on `created_at`.
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
    'legacy', 'forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human'
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

comment on function staff_permission_decisions(text, int, timestamptz) is
  'PERM2-11: latest gates, filtered by stage (or legacy), with who or what decided and the reason codes of decision_detail only. Staff read only, p_limit bounded to 500.';

revoke all on function staff_permission_decisions(text, int, timestamptz) from public;
grant execute on function staff_permission_decisions(text, int, timestamptz) to ohb_api;

-- Bots to watch: stored in `bypass`, or in a `v2` organization whose host
-- policy is not proven effective (PERM2-2: no run starts). The expected host
-- mode repeats `approvalPolicyMode` of `runtime-contract.ts` under `v2`:
-- `block_writes` for `plan`, `ask_writes` otherwise. Live bots of live
-- organizations only; the organization ceiling comes along so the screen can
-- say when `bypass` is capped.
create or replace function staff_permission_bots(p_limit int default 2000)
returns table (
  bot_id uuid,
  bot_name text,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  pipeline text,
  permission_mode text,
  approval_policy_mode text,
  approval_policy_effective_at timestamptz,
  expected_policy_mode text,
  max_mode text,
  enforce_review boolean,
  in_bypass boolean,
  policy_not_effective boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  return query
    with candidates as (
      select b.id as bot_id, b.name as bot_name, o.id as organization_id, o.name as organization_name,
             o.slug as organization_slug, o.permission_pipeline as pipeline, b.permission_mode,
             b.approval_policy_mode, b.approval_policy_effective_at,
             case when o.permission_pipeline = 'v2'
               then case when b.permission_mode = 'plan' then 'block_writes' else 'ask_writes' end
             end as expected_policy_mode,
             p.max_mode, coalesce(p.enforce_review, false) as enforce_review
        from public.bots b
        join public.organizations o on o.id = b.organization_id
        left join public.organization_permission_policies p on p.organization_id = o.id
       where o.deleted_at is null
         and b.deleted_at is null
         and b.archived_at is null
    )
    select c.bot_id, c.bot_name, c.organization_id, c.organization_name, c.organization_slug,
           c.pipeline, c.permission_mode, c.approval_policy_mode, c.approval_policy_effective_at,
           c.expected_policy_mode, c.max_mode, c.enforce_review,
           c.permission_mode = 'bypass',
           c.pipeline = 'v2' and (
             c.approval_policy_effective_at is null
             or c.approval_policy_mode is distinct from c.expected_policy_mode
           )
      from candidates c
     where c.permission_mode = 'bypass'
        or (c.pipeline = 'v2' and (
              c.approval_policy_effective_at is null
              or c.approval_policy_mode is distinct from c.expected_policy_mode
            ))
     order by c.organization_name, c.bot_name, c.bot_id
     limit greatest(1, least(coalesce(p_limit, 2000), 2000));
end;
$$;

comment on function staff_permission_bots(int) is
  'PERM2-11: live bots in bypass, or whose host policy is not proven effective under v2 (PERM2-2), with the organization ceiling. Staff read only, p_limit bounded to 2000.';

revoke all on function staff_permission_bots(int) from public;
grant execute on function staff_permission_bots(int) to ohb_api;

insert into schema_migrations(version) values ('0143_staff_permission_audit');
commit;
