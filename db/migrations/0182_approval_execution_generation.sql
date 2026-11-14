-- Hermes 0.23 answers a gate only with the turn it belongs to: the answer is
-- exactly {request_id, execution_generation, choice}, anything else is a 400.
-- The worker reads `execution_generation` on the raw `approval.request` and
-- keeps it here beside `hermes_request_id` (0137). Null: a Hermes 0.22 gate,
-- or a row written before this migration, answered with the 0.22 body.
--
-- ADDITIVE: nullable, no backfill; the previous release never reads it.
begin;

alter table approval_requests
  add column if not exists hermes_execution_generation bigint null
    constraint approval_requests_hermes_execution_generation_check
      check (hermes_execution_generation is null or hermes_execution_generation >= 0);

insert into schema_migrations(version) values ('0182_approval_execution_generation')
on conflict (version) do nothing;
commit;
