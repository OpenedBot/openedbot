begin;

-- A reservation belongs to one WebSocket for its entire lifetime. Keeping the
-- last generation after release prevents delayed writes from resurrecting it.
create sequence runtime_link_generation_seq as bigint;
grant usage on sequence runtime_link_generation_seq to openedbot_api;
alter table runtimes add column link_generation bigint not null default 0
  check (link_generation >= 0);
comment on column runtimes.link_generation is
  'Database-ordered WebSocket lease. Every liveness write must fence by this generation and instance.';

-- These identify the socket that received a persisted/spooled diagnostic, not
-- the socket where its original failure occurred. Historical rows stay NULL.
alter table runtime_link_diagnostics
  add column receiver_instance_id text,
  add column receiver_generation bigint check (receiver_generation > 0);
comment on column runtime_link_diagnostics.receiver_instance_id is
  'Receiving broker api_instances.instance_id; not the origin of a spooled event.';
comment on column runtime_link_diagnostics.receiver_generation is
  'Receiving WebSocket lease generation; not the generation at original failure time.';
alter table runtime_link_events add column meta jsonb not null default '{}'::jsonb
  check (jsonb_typeof(meta) = 'object');

comment on column runtime_link_events.meta is
  'Connection instance/generation and close details. ownershipCurrent records fenced DB ownership at close: false for stale sockets, null if persistence failed; a disconnected event is not the current runtime state.';

insert into schema_migrations(version) values ('0051_runtime_link_generation') on conflict (version) do nothing;
commit;
