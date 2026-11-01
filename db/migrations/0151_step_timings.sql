-- Step durations kept for analysis, next to the row they measure. Until now
-- they only lived in worker log lines (`run.latency`, OHB-107;
-- `profile_provision.timings`, DEV-OHB-244), lost with the process output.
-- A provision carries them in the update that already closes its pass. A
-- run gets them in a write the worker does not wait for, once the run is
-- over: a failed write costs a log line, never the run. Names and durations
-- only (`RunTrace` drops anything else): never a message, prompt or host
-- answer. They live and go with their row, so no retention of their own.
-- Not the product analytics removed in 0107: no event table, no rollup.
begin;

alter table runs
  add column if not exists timings jsonb;

comment on column runs.timings is
  'Latency of the worker pass (`runLatencyRecord`): queuedMs, marks and spans in ms from the claim, verdicts. Names and durations only.';

alter table bot_profile_provisions
  add column if not exists timings jsonb;

comment on column bot_profile_provisions.timings is
  'Durations of the last provisioning pass in ms (claim wait, precheck, host create, approval policy, gateway serve wait, total) and its outcome. Names and durations only.';

insert into schema_migrations(version) values ('0151_step_timings')
on conflict (version) do nothing;

commit;
