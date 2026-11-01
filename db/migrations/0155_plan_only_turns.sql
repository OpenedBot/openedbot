-- "Plan first" becomes the intent of one turn, not a state of the bot.
--
-- Until now the composer's "Mode plan" rewrote `bots.permission_mode`: every
-- run of the bot, routines included, stayed in plan until someone switched
-- it back. The operator now asks for a plan on ONE message: its run carries
-- `runs.plan_only`, and a workflow it opens (room, hand-off, autonomy)
-- carries `workflows.plan_only`, so the runs the worker spawns in it plan
-- too. Both are set at insert and never change.
--
-- The flag only narrows: the worker decides the turn's gates as `plan`
-- whatever the bot's mode, and the routine and settings tools refuse to
-- write. Under the `legacy` pipeline an `auto` bot's host does not submit
-- its writes (`approval_policy = off`), so there the plan holds through the
-- prompt and the worker never answering a gate, not through the host.
begin;

alter table runs
  add column if not exists plan_only boolean not null default false;

comment on column runs.plan_only is
  'The operator asked this turn for a plan only: decided as `plan` whatever the bot''s permission mode. Set at insert, never changed.';

alter table workflows
  add column if not exists plan_only boolean not null default false;

comment on column workflows.plan_only is
  'The message that opened this workflow asked for a plan only: every run of the workflow is decided as `plan`. Set at insert, never changed.';

insert into schema_migrations(version) values ('0155_plan_only_turns')
on conflict (version) do nothing;

commit;
