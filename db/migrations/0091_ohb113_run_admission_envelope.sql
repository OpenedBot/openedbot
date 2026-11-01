begin;

-- OHB-113: a plain DM (no room, no explicit handoff, autonomy off) no longer
-- opens a `workflows` row. The two facts the workflow carried for such a
-- turn now live on the run itself:
--   - `initiator_user_id`: who sent it. Folding a follow-up and creating a
--     message variant stay restricted to the same member.
--   - `deadline_at`: the admission ceiling (bot autonomy timeout), frozen at
--     send time. The queue expires a run still waiting past it, and the
--     worker bounds the step by it.
-- Both stay null on workflow steps, whose workflow keeps carrying them.
-- Only an uncertain outcome gives such a turn a workflow (see the trigger).
alter table runs
  add column if not exists initiator_user_id uuid,
  add column if not exists deadline_at timestamptz;

alter table runs
  drop constraint if exists runs_initiator_user_fkey,
  add constraint runs_initiator_user_fkey
    foreign key (organization_id, initiator_user_id)
    references memberships(organization_id, user_id) on delete set null (initiator_user_id);

create index if not exists runs_queued_deadline_idx
  on runs (deadline_at)
  where status = 'queued' and workflow_id is null and deadline_at is not null;

-- An `unknown` run blocks its thread until an operator reconciles, abandons
-- or retries it, and every one of those paths (routes, inbox, recovery
-- dialog) is keyed by workflow. When a plain DM turn becomes uncertain, the
-- review workflow it never needed until then is opened here, in the same
-- statement, so no writer that marks a run `unknown` has to know about it.
-- Same ordering key as the run (created_at); no push: a plain DM is never
-- notification-eligible and the push trigger only fires on a status change.
create or replace function open_plain_dm_review_workflow()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  review_id uuid;
begin
  if new.status is distinct from 'unknown' or old.status = 'unknown'
     or new.workflow_id is not null or new.step_kind is distinct from 'root'
     or new.initiator_user_id is null then
    return new;
  end if;
  review_id := gen_random_uuid();
  insert into public.workflows (
    id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
    kind, status, timeout_seconds, used_steps, deadline_at,
    error_code, error_message, created_at, started_at, updated_at
  ) values (
    review_id, new.organization_id, new.thread_id, new.id, new.bot_id, new.initiator_user_id,
    'dm', 'unknown',
    least(3600, greatest(60, coalesce(extract(epoch from (new.deadline_at - new.created_at))::integer, 1800))),
    1, coalesce(new.deadline_at, now()),
    new.error_code, new.error_message, new.created_at, coalesce(new.started_at, now()), now()
  );
  new.workflow_id := review_id;
  return new;
end;
$$;
revoke all on function open_plain_dm_review_workflow() from public;

drop trigger if exists runs_plain_dm_review_workflow on runs;
create trigger runs_plain_dm_review_workflow
before update of status on runs
for each row execute function open_plain_dm_review_workflow();

insert into schema_migrations(version)
values ('0091_ohb113_run_admission_envelope')
on conflict (version) do nothing;

commit;
