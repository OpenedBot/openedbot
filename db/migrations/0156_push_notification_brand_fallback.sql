-- A push notification whose bot has no readable name used to be titled
-- "openedbot", the old internal name of the product. Same function as 0039, only
-- the fallback title changes: "openedbot", the name the operator sees
-- everywhere else.
begin;

create or replace function enqueue_push_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot_name text;
  event_type text;
begin
  if not (new.autonomy_enabled or new.kind in ('group', 'routine'))
     or old.status is not distinct from new.status then
    return new;
  end if;

  event_type := case
    when new.status = 'awaiting_approval' then 'approval.requested'
    when new.status = 'completed' then 'run.completed'
    when new.status in ('failed', 'expired', 'unknown') then 'run.error'
    else null
  end;
  if event_type is null then
    return new;
  end if;

  select name into snapshot_name
    from public.bots
   where organization_id = new.organization_id and id = new.root_bot_id;

  insert into public.push_outbox (
    organization_id, workflow_id, notification_sequence,
    event_type, bot_id, bot_name
  ) values (
    new.organization_id, new.id, new.notification_sequence,
    event_type, new.root_bot_id, left(coalesce(nullif(snapshot_name, ''), 'openedbot'), 200)
  ) on conflict (organization_id, workflow_id, notification_sequence) do nothing;
  return new;
end;
$$;
revoke all on function enqueue_push_notification() from public;

insert into schema_migrations(version) values ('0156_push_notification_brand_fallback')
on conflict (version) do nothing;

commit;
