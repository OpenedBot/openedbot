begin;

-- Every run without a workflow that becomes `unknown` gets a review workflow
-- (ADR 0001 S2b, defect D1 of docs/architecture/0002-invariants-des-runs.md).
--
-- 0091 opened one only for a root DM with an initiator. A persona draft, the
-- inbound run of a legacy `@slug` handoff, a legacy room turn, or a DM whose
-- initiator the deletion of its account nulled (an agency operator) stayed
-- `unknown` with no workflow. Every exit from `unknown` (reconcile, abandon,
-- retry, the inbox) is keyed by workflow, and the thread stop and run cancel
-- routes refuse an `unknown` run: the thread stayed blocked and the run held
-- a runtime slot until someone wrote SQL.
--
-- This migration replaces 0091's function and trigger with one that keeps its
-- behaviour for a root DM and drops the two exclusions: the review is a `group`
-- workflow for a room thread (whose retry the API refuses: the roster may have
-- changed), `dm` otherwise, with the run's initiator, possibly null. As in
-- 0091 it is opened in the same statement as the transition, so no writer that
-- marks a run `unknown` has to know about it, and it notifies nobody (the push
-- trigger only fires on a later status change).
create or replace function open_unknown_run_review_workflow()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  review_id uuid;
  review_kind text;
begin
  if new.status is distinct from 'unknown' or old.status = 'unknown'
     or new.workflow_id is not null then
    return new;
  end if;
  select case when thread.group_id is null then 'dm' else 'group' end
    into review_kind
    from public.threads thread
   where thread.organization_id = new.organization_id and thread.id = new.thread_id;
  review_id := gen_random_uuid();
  insert into public.workflows (
    id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
    kind, status, timeout_seconds, used_steps, deadline_at,
    error_code, error_message, created_at, started_at, updated_at
  ) values (
    review_id, new.organization_id, new.thread_id, new.id, new.bot_id, new.initiator_user_id,
    coalesce(review_kind, 'dm'), 'unknown',
    least(3600, greatest(60, coalesce(extract(epoch from (new.deadline_at - new.created_at))::integer, 1800))),
    1, coalesce(new.deadline_at, now()),
    new.error_code, new.error_message, new.created_at, coalesce(new.started_at, now()), now()
  );
  new.workflow_id := review_id;
  return new;
end;
$$;
revoke all on function open_unknown_run_review_workflow() from public;

drop trigger if exists runs_plain_dm_review_workflow on runs;
drop function if exists open_plain_dm_review_workflow();

drop trigger if exists runs_unknown_review_workflow on runs;
create trigger runs_unknown_review_workflow
before update of status on runs
for each row execute function open_unknown_run_review_workflow();

insert into schema_migrations(version)
values ('0175_review_path_for_every_unknown_run')
on conflict (version) do nothing;

commit;
