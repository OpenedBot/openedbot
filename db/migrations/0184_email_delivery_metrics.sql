-- Additive rollout: apply migration, restart API, then restart alerting.
-- Only aggregates cross this boundary; API must never SELECT the PII outbox.
begin;

-- The audit journal is best effort: a crash after UPDATE must not erase a
-- delivery failure from monitoring. Stamp the source row in the same write.
alter table public.email_outbox add column last_delivery_failure_at timestamptz;

create function public.stamp_email_delivery_failure()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status = 'failed' or (new.status = 'pending' and new.last_error is not null) then
    if tg_op = 'INSERT' then
      new.last_delivery_failure_at := now();
    elsif new.status is distinct from old.status
       or new.attempts is distinct from old.attempts
       or new.last_error is distinct from old.last_error then
      new.last_delivery_failure_at := now();
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_email_delivery_failure() from public;
create trigger email_outbox_delivery_failure_stamp
before insert or update of status, attempts, last_error on public.email_outbox
for each row execute function public.stamp_email_delivery_failure();

-- Historical failure time is unknown without the journal. Surface existing
-- failed/retrying rows conservatively for ten minutes after the migration.
update public.email_outbox set last_delivery_failure_at = now()
 where status = 'failed' or (status = 'pending' and last_error is not null);

create index email_outbox_recent_delivery_failure_idx
  on public.email_outbox (last_delivery_failure_at)
  where kind in ('email_login_code', 'staff_login_code')
    and last_delivery_failure_at is not null;

create function public.internal_email_delivery_metrics()
returns table (
  pending_login_codes bigint,
  oldest_login_code_age_seconds double precision,
  recent_login_code_failures bigint
)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select count(*),
         coalesce(greatest(0, extract(epoch from now() - min(created_at))), 0)::double precision,
         -- One message counts once, even after several retries and a failure.
         (select count(*) from public.email_outbox
           where kind in ('email_login_code', 'staff_login_code')
             and last_delivery_failure_at >= now() - interval '10 minutes')
    from public.email_outbox
   where kind in ('email_login_code', 'staff_login_code')
     and status in ('pending', 'sending');
$$;
alter function public.internal_email_delivery_metrics() owner to openedbot_migrator;
revoke all on function public.internal_email_delivery_metrics() from public;
grant execute on function public.internal_email_delivery_metrics() to openedbot_api;

insert into schema_migrations(version) values ('0184_email_delivery_metrics')
on conflict (version) do nothing;
commit;
