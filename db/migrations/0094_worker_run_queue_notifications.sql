-- Empty hints contain no tenant or run data. PostgreSQL delivers them only
-- after the admitting/requeueing transaction commits; the claim remains durable.
begin;
create or replace function notify_worker_run_queue() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'queued' then
      perform pg_catalog.pg_notify('openedbot_run_queue_v1', '');
    end if;
  elsif (new.status = 'queued' and
      (old.status is distinct from new.status or old.next_attempt_at is distinct from new.next_attempt_at))
    or (old.status in ('starting', 'running', 'awaiting_approval', 'relaying') and
      (new.status not in ('starting', 'running', 'awaiting_approval', 'relaying')
        or (old.lease_owner is not null and new.lease_owner is null))) then
    perform pg_catalog.pg_notify('openedbot_run_queue_v1', '');
  end if;
  return new;
end;
$$;

-- Repair an unrecorded partial installation from an interrupted migration.
drop trigger if exists runs_queue_wakeup on runs;
create trigger runs_queue_wakeup
after insert or update of status, next_attempt_at, lease_owner on runs
for each row execute function notify_worker_run_queue();

insert into schema_migrations(version) values ('0094_worker_run_queue_notifications');
commit;
