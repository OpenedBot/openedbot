insert into organizations (id, slug, name) values
  ('8c000000-0000-4000-8000-000000000001', 'cleanup-a', 'Cleanup A'),
  ('8d000000-0000-4000-8000-000000000002', 'cleanup-b', 'Cleanup B');
insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active) values
  ('8c000000-0000-4000-8000-000000000031', '8c000000-0000-4000-8000-000000000001', 'A', 'connector', 'cleanup-a', false),
  ('8d000000-0000-4000-8000-000000000032', '8d000000-0000-4000-8000-000000000002', 'B', 'connector', 'cleanup-b', false);
insert into bot_host_cleanups (id, organization_id, bot_id, bot_deleted_at, runtime_id, profile, session_ids, status) values
  ('8c000000-0000-4000-8000-000000000041', '8c000000-0000-4000-8000-000000000001', '8c000000-0000-4000-8000-000000000051', '2026-10-01T00:00:00Z', '8c000000-0000-4000-8000-000000000031', 'a', '{session-a}', 'succeeded'),
  ('8c000000-0000-4000-8000-000000000043', '8c000000-0000-4000-8000-000000000001', '8c000000-0000-4000-8000-000000000051', '2026-10-15T00:00:00Z', '8c000000-0000-4000-8000-000000000031', 'a', '{session-a}', 'queued'),
  ('8d000000-0000-4000-8000-000000000042', '8d000000-0000-4000-8000-000000000002', '8d000000-0000-4000-8000-000000000052', '2026-10-01T00:00:00Z', '8d000000-0000-4000-8000-000000000032', 'b', '{session-b}', 'queued');
set role openedbot_api;
select set_config('app.organization_id', '8c000000-0000-4000-8000-000000000001', false) \g /dev/null
do $$
begin
  if (select count(*) from bot_host_cleanups) <> 2 then raise exception 'tenant A did not see both deletion generations'; end if;
  if (select count(*) from bot_host_cleanups where bot_id = '8c000000-0000-4000-8000-000000000051' and bot_deleted_at = '2026-10-15T00:00:00Z' and status = 'queued') <> 1 then raise exception 'new deletion did not get its own cleanup'; end if;
  if (select count(*) from bot_host_cleanups where organization_id = '8d000000-0000-4000-8000-000000000002') <> 0 then raise exception 'tenant A saw tenant B cleanup'; end if;
  update bot_host_cleanups set status = 'cancelled' where id = '8c000000-0000-4000-8000-000000000041';
  if not found then raise exception 'tenant A could not cancel its cleanup'; end if;
  update bot_host_cleanups set status = 'cancelled' where id = '8d000000-0000-4000-8000-000000000042';
  if found then raise exception 'tenant A cancelled tenant B cleanup'; end if;
  begin
    delete from bot_host_cleanups where id = '8c000000-0000-4000-8000-000000000041';
    raise exception 'API role unexpectedly deleted a cleanup';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
do $$
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'bot_host_cleanups'::regclass) then raise exception 'cleanup RLS is not forced'; end if;
end
$$;
select 'isolated/forced';
delete from organizations where id in (
  '8c000000-0000-4000-8000-000000000001',
  '8d000000-0000-4000-8000-000000000002'
);
