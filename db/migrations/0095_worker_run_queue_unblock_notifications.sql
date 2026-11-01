-- Unknown outcomes also block FIFO/capacity. Their explicit reconciliation
-- must wake an already queued follower, including a prioritized stop request.
begin;
create or replace function notify_worker_run_queue() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'queued' then
      perform pg_catalog.pg_notify('ohb_run_queue_v1', '');
    end if;
  elsif (new.status = 'queued' and
      (old.status is distinct from new.status or old.next_attempt_at is distinct from new.next_attempt_at
        or old.remote_stop_state is distinct from new.remote_stop_state))
    or (old.status in ('starting', 'running', 'awaiting_approval', 'relaying', 'unknown') and
      (new.status not in ('starting', 'running', 'awaiting_approval', 'relaying', 'unknown')
        or (old.lease_owner is not null and new.lease_owner is null))) then
    perform pg_catalog.pg_notify('ohb_run_queue_v1', '');
  end if;
  return new;
end;
$$;

drop trigger runs_queue_wakeup on runs;
create trigger runs_queue_wakeup
after insert or update of status, next_attempt_at, lease_owner, remote_stop_state on runs
for each row execute function notify_worker_run_queue();

insert into schema_migrations(version) values ('0095_worker_run_queue_unblock_notifications');
commit;
