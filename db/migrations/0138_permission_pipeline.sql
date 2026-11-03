begin;

-- PERM2-1 (DEV-OHB-251): the permission pipeline of US-PERM2 behind a flag.
--
-- `organizations.permission_pipeline` chooses who answers a gate: `legacy`
-- keeps today's heuristic (`workerMayApproveGate`), `v2` runs the pipeline
-- (`modules/execution/src/domain/permission-decision.ts`). Three locks keep
-- an old worker from approving silently in a `v2` organization:
--   1. every worker announces the pipelines it knows in its heartbeat
--      (`service_instances.permission_pipelines`);
--   2. `staff_set_permission_pipeline` refuses `v2` while a worker seen in
--      the last 10 minutes does not announce it, or a run of the
--      organization still holds a lease;
--   3. `approval_requests_permission_guard` refuses, in a `v2` organization,
--      a gate resolved by a policy without the pipeline's trace: an old
--      binary fails its write instead of approving.

alter table organizations
  add column permission_pipeline text not null default 'legacy'
    constraint organizations_permission_pipeline_check
      check (permission_pipeline in ('legacy', 'v2'));

alter table service_instances
  add column permission_pipelines text[] null
    constraint service_instances_permission_pipelines_check
      check (permission_pipelines is null or permission_pipelines <@ array['legacy', 'v2']::text[]);

-- The revision a policy decision was taken at. A trigger raises it on every
-- write that can change a decision (here: the mode, and the organization's
-- pipeline); later stories add their tables. It never goes down: a writer
-- may only raise it, the trigger keeps the larger value.
alter table bots
  add column permission_revision bigint not null default 0
    constraint bots_permission_revision_check check (permission_revision >= 0);

create or replace function bots_raise_permission_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.permission_revision := greatest(
    new.permission_revision,
    old.permission_revision + case when new.permission_mode is distinct from old.permission_mode then 1 else 0 end
  );
  return new;
end;
$$;

create trigger bots_permission_revision
before update on bots
for each row execute function bots_raise_permission_revision();

create or replace function organizations_permission_pipeline_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.id;
  return new;
end;
$$;

create trigger organizations_permission_pipeline_revision
after update of permission_pipeline on organizations
for each row when (new.permission_pipeline is distinct from old.permission_pipeline)
execute function organizations_permission_pipeline_revision();

-- The pipeline's trace on the gate. `decision_state` is null on a `legacy`
-- gate. `awaiting_human` is the only state the human answer route accepts in
-- `v2`; `reviewing` belongs to the reviewer (PERM2-7).
alter table approval_requests
  add column decision_state text null
    constraint approval_requests_decision_state_check
      check (decision_state is null or decision_state in ('reviewing', 'awaiting_human', 'decided')),
  add column decision_stage text null
    constraint approval_requests_decision_stage_check
      check (decision_stage is null or decision_stage in
        ('forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human')),
  add column decided_by_kind text null
    constraint approval_requests_decided_by_kind_check
      check (decided_by_kind is null or decided_by_kind in ('member', 'agency', 'policy')),
  add column permission_revision_seen bigint null
    constraint approval_requests_permission_revision_seen_check
      check (permission_revision_seen is null or permission_revision_seen >= 0),
  add column decision_detail jsonb null
    constraint approval_requests_decision_detail_check
      check (decision_detail is null or (jsonb_typeof(decision_detail) = 'object' and octet_length(decision_detail::text) <= 2048));

-- A `v2` deny can come from a manual or plan bot (an interdiction): the
-- policy that answered is the effective mode, not only auto / bypass.
alter table approval_requests drop constraint approval_requests_resolved_by_policy_check;
alter table approval_requests
  add constraint approval_requests_resolved_by_policy_check
    check (resolved_by_policy is null or resolved_by_policy in ('auto', 'bypass', 'manual', 'plan'));

create or replace function approval_requests_permission_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pipeline text;
begin
  select o.permission_pipeline into pipeline from public.organizations o where o.id = new.organization_id;
  if pipeline is distinct from 'v2' then
    return new;
  end if;
  if new.resolved_by_policy is not null and (
    new.decision_stage is null or new.permission_revision_seen is null or new.decided_by_kind is distinct from 'policy'
  ) then
    raise exception 'approval resolved by a policy without the permission pipeline trace'
      using errcode = '23514', hint = 'APPROVAL_POLICY_DECISION_UNTRACKED';
  end if;
  -- A worker that does not know the pipeline leaves a human gate without a
  -- state: in `v2` it is a human's.
  if tg_op = 'INSERT' and new.decision_state is null and new.status = 'pending' then
    new.decision_state := 'awaiting_human';
  end if;
  return new;
end;
$$;

create trigger approval_requests_permission_guard
before insert or update on approval_requests
for each row execute function approval_requests_permission_guard();

-- The backoffice switch. It answers a status instead of raising for the
-- normal refusals; it never lets an organization into `v2` while a worker
-- could still answer its gates the old way.
create or replace function staff_set_permission_pipeline(
  p_organization_id uuid,
  p_pipeline text
)
returns table (status text, previous_pipeline text, current_pipeline text, reverted_gates integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  current_value text;
  reverted integer := 0;
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
  if p_pipeline is null or p_pipeline not in ('legacy', 'v2') then
    raise exception 'unknown permission pipeline' using errcode = '22023';
  end if;

  select o.permission_pipeline into current_value
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if current_value is null then
    return;
  end if;
  if current_value = p_pipeline then
    return query select 'unchanged'::text, current_value, current_value, 0;
    return;
  end if;

  if p_pipeline = 'v2' then
    if not exists (
      select 1 from public.service_instances si
       where si.service = 'worker' and si.heartbeat_at > now() - interval '10 minutes'
    ) or exists (
      select 1 from public.service_instances si
       where si.service = 'worker' and si.heartbeat_at > now() - interval '10 minutes'
         and not ('v2' = any(coalesce(si.permission_pipelines, array[]::text[])))
    ) then
      return query select 'workers_not_ready'::text, current_value, current_value, 0;
      return;
    end if;
    if exists (
      select 1 from public.runs r
       where r.organization_id = p_organization_id
         and r.status in ('starting', 'running', 'awaiting_approval')
         and r.lease_expires_at > now()
    ) then
      return query select 'runs_in_flight'::text, current_value, current_value, 0;
      return;
    end if;
  else
    -- Back to `legacy`: a decision the pipeline took and Hermes has not
    -- received yet goes back to a human. Nothing is lost, nothing is sent.
    -- A gate a worker is claiming right now is skipped, not waited for: that
    -- worker waits on this organization row, and it leaves with the decision
    -- it already holds.
    with candidates as (
      select a.id from public.approval_requests a
       where a.organization_id = p_organization_id
         and a.decided_by_kind = 'policy' and a.forward_state in ('pending', 'ready')
       for update skip locked
    ), reverted_rows as (
      update public.approval_requests a
         set status = 'pending', selected_choice = null, resolved_at = null, resolved_by_policy = null,
             forward_state = 'pending', decision_state = 'awaiting_human', decision_stage = null,
             decided_by_kind = null, decision_detail = jsonb_build_object('revertedToLegacy', true)
        from candidates c
       where a.id = c.id
      returning 1
    )
    select count(*)::integer into reverted from reverted_rows;
  end if;

  update public.organizations set permission_pipeline = p_pipeline where id = p_organization_id;
  return query select 'switched'::text, current_value, p_pipeline, reverted;
end;
$$;

comment on function staff_set_permission_pipeline(uuid, text) is
  'Switches an organization between the legacy permission heuristic and the v2 pipeline (PERM2-1). Refuses v2 (workers_not_ready, runs_in_flight) while an old worker or a leased run could answer a gate the old way; back to legacy, returns undelivered policy decisions to a human. Guarded by app.staff_user_id.';

revoke all on function staff_set_permission_pipeline(uuid, text) from public;
grant execute on function staff_set_permission_pipeline(uuid, text) to ohb_api;

insert into schema_migrations(version) values ('0138_permission_pipeline');
commit;
