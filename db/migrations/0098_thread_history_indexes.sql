-- Keyset transcript pages seek complete turns across every run status.
begin;

create index runs_thread_history_idx on runs
  (organization_id, thread_id, created_at desc, id desc);

create index messages_thread_standalone_history_idx on messages
  (organization_id, thread_id, created_at desc, id desc) where run_id is null;

create index runs_thread_live_history_idx on runs
  (organization_id, thread_id, id)
  where ended_at is null or status = 'unknown' or external_state = 'ambiguous';

insert into schema_migrations(version) values ('0098_thread_history_indexes');
commit;
