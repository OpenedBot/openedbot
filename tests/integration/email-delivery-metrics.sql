-- Run only in the disposable integration database; roll back fixtures.
begin;
delete from email_outbox;
delete from email_outbox_events;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.internal_email_delivery_metrics()'::regprocedure
       and r.rolname = 'openedbot_migrator' and r.rolbypassrls
       and p.prosecdef and p.provolatile = 's'
       and p.proconfig = array['search_path=pg_catalog, pg_temp']
  ) then raise exception 'Unsafe email metrics function'; end if;
  if has_function_privilege('openedbot_worker', 'public.internal_email_delivery_metrics()', 'execute')
     or has_function_privilege('openedbot_staff', 'public.internal_email_delivery_metrics()', 'execute')
     or exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) acl
                 where p.oid = 'public.internal_email_delivery_metrics()'::regprocedure and acl.grantee = 0)
  then raise exception 'Email metrics execute is not API-only'; end if;
end $$;

set local role openedbot_api;
do $$
declare m record;
begin
  select * into strict m from public.internal_email_delivery_metrics();
  if m.pending_login_codes <> 0 or m.oldest_login_code_age_seconds <> 0 or m.recent_login_code_failures <> 0
  then raise exception 'Empty metrics must be zero'; end if;
  begin
    perform recipient_email from public.email_outbox;
    raise exception 'API can read email PII';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

insert into email_outbox(id, kind, dedupe_key, payload, status, created_at) values
  (gen_random_uuid(), 'email_login_code', 'metrics-pending', '{}', 'pending', now() - interval '150 seconds'),
  (gen_random_uuid(), 'staff_login_code', 'metrics-sending', '{}', 'sending', now() - interval '180 seconds'),
  (gen_random_uuid(), 'email_login_code', 'metrics-sent', '{}', 'sent', now() - interval '1 hour'),
  (gen_random_uuid(), 'email_login_code', 'metrics-failed', '{}', 'failed', now() - interval '1 hour'),
  (gen_random_uuid(), 'account_purge_completed', 'metrics-other', '{}', 'pending', now() - interval '1 day');
-- A terminal failure is visible even when the worker crashes before audit INSERT.
set local role openedbot_api;
do $$
begin
  if (select recent_login_code_failures from public.internal_email_delivery_metrics()) <> 1
  then raise exception 'Terminal failure without audit event was lost'; end if;
end $$;
reset role;
set local role openedbot_worker;
-- Retry the same message twice, then fail it: the gauge must count it once.
update email_outbox set status = 'sending', attempts = 1 where dedupe_key = 'metrics-failed';
update email_outbox set status = 'pending', last_error = 'provider unavailable' where dedupe_key = 'metrics-failed';
update email_outbox set status = 'sending', attempts = 2, last_error = null where dedupe_key = 'metrics-failed';
update email_outbox set status = 'failed', last_error = 'provider unavailable' where dedupe_key = 'metrics-failed';
-- A retry with no audit event at the inclusive window boundary counts too.
update email_outbox set last_error = 'provider unavailable' where dedupe_key = 'metrics-pending';
update email_outbox set last_delivery_failure_at = now() - interval '10 minutes' where dedupe_key = 'metrics-pending';
update email_outbox set last_delivery_failure_at = now() - interval '10 minutes 1 second' where dedupe_key = 'metrics-sent';
-- Duplicated audit entries cannot double-count incidents or invent failures.
insert into email_outbox_events(outbox_id, kind, event)
select id, kind, 'failed' from email_outbox where dedupe_key = 'metrics-failed';
insert into email_outbox_events(outbox_id, kind, event)
select id, kind, 'retry' from email_outbox where dedupe_key = 'metrics-failed';
insert into email_outbox_events(kind, event) values ('email_login_code', 'failed');
reset role;

set local role openedbot_api;
do $$
declare m record;
begin
  select * into strict m from public.internal_email_delivery_metrics();
  if m.pending_login_codes <> 2 or m.oldest_login_code_age_seconds <> 180 or m.recent_login_code_failures <> 2
  then raise exception 'Incorrect OTP metrics: %', row_to_json(m); end if;
end $$;
reset role;
-- Delivery recovery, with historical failures outside the rolling window.
update email_outbox set status = 'sent';
-- Successful delivery does not erase a recent incident; it ages out.
set local role openedbot_api;
do $$
begin
  if (select recent_login_code_failures from public.internal_email_delivery_metrics()) <> 2
  then raise exception 'Success erased recent delivery failures'; end if;
end $$;
reset role;
update email_outbox set last_delivery_failure_at = now() - interval '10 minutes 1 second';
set local role openedbot_api;
do $$
declare m record;
begin
  select * into strict m from public.internal_email_delivery_metrics();
  if m.pending_login_codes <> 0 or m.oldest_login_code_age_seconds <> 0 or m.recent_login_code_failures <> 0
  then raise exception 'Recovered metrics must be zero'; end if;
end $$;
reset role;
rollback;
