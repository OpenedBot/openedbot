begin;

-- PERM2-9 (DEV-OHB-260): runs nobody attends.
--
-- `routines.never_wait` is the per-routine option "Never wait": a gate of a
-- run this routine fired that would wait for a person is refused at once
-- instead (iso hermes-agent `approvals.cron_mode: deny`, tools/approval.py).
-- It only ever turns a human wait into a refusal: it never answers `once`
-- and never lifts an interdiction or a floor. A routine the bot creates
-- through `routine_manage` is born with it; an operator's defaults to off
-- (today's behavior: the gate waits, notifies and expires).
--
-- `workflows.never_wait` is the snapshot taken when the routine fires (the
-- scheduled tick and the manual "Run now"): every step of that workflow is
-- decided under the value the routine had at that instant, and an edit of
-- the routine counts for its next occurrence.
alter table routines
  add column never_wait boolean not null default false;

alter table workflows
  add column never_wait boolean not null default false;

-- The stage of a gate refused because nobody waits for it. The stage it was
-- held at (floor, deletion, review escalation...) stays in `decision_detail`.
alter table approval_requests drop constraint approval_requests_decision_stage_check;
alter table approval_requests
  add constraint approval_requests_decision_stage_check
    check (decision_stage is null or decision_stage in
      ('forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human', 'unattended'));

insert into schema_migrations(version) values ('0144_routine_never_wait');
commit;
