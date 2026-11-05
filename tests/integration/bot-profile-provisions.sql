insert into organizations (id, slug, name) values
  ('7c000000-0000-4000-8000-000000000001', 'provision-a', 'Provision A'),
  ('7d000000-0000-4000-8000-000000000002', 'provision-b', 'Provision B');
insert into sections (id, organization_id, name, position) values
  ('7c000000-0000-4000-8000-000000000011', '7c000000-0000-4000-8000-000000000001', 'A', 0),
  ('7d000000-0000-4000-8000-000000000012', '7d000000-0000-4000-8000-000000000002', 'B', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('7c000000-0000-4000-8000-000000000021', '7c000000-0000-4000-8000-000000000001', '7c000000-0000-4000-8000-000000000011', 'A', 'a', 'a', 0),
  ('7d000000-0000-4000-8000-000000000022', '7d000000-0000-4000-8000-000000000002', '7d000000-0000-4000-8000-000000000012', 'B', 'b', 'b', 0);
insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active) values
  ('7c000000-0000-4000-8000-000000000031', '7c000000-0000-4000-8000-000000000001', 'A', 'connector', 'provision-a', false),
  ('7d000000-0000-4000-8000-000000000032', '7d000000-0000-4000-8000-000000000002', 'B', 'connector', 'provision-b', false);
insert into bot_profile_provisions (bot_id, organization_id, runtime_id, slug, display_name) values
  ('7c000000-0000-4000-8000-000000000021', '7c000000-0000-4000-8000-000000000001', '7c000000-0000-4000-8000-000000000031', 'a', 'A'),
  ('7d000000-0000-4000-8000-000000000022', '7d000000-0000-4000-8000-000000000002', '7d000000-0000-4000-8000-000000000032', 'b', 'B');
set role openedbot_api;
select set_config('app.organization_id', '7c000000-0000-4000-8000-000000000001', false) \g /dev/null
do $$
begin
  if (select count(*) from bot_profile_provisions) <> 1 then raise exception 'tenant A did not see its provision'; end if;
  if (select count(*) from bot_profile_provisions where organization_id = '7d000000-0000-4000-8000-000000000002') <> 0 then raise exception 'tenant A saw tenant B provision'; end if;
  -- La corbeille annule par une mise à jour (pierre tombale), jamais par DELETE.
  update bot_profile_provisions set status = 'cancelled' where bot_id = '7c000000-0000-4000-8000-000000000021';
  if not found then raise exception 'tenant A could not cancel its provision'; end if;
  update bot_profile_provisions set status = 'cancelled' where bot_id = '7d000000-0000-4000-8000-000000000022';
  if found then raise exception 'tenant A cancelled tenant B provision'; end if;
end
$$;
reset role;
do $$
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'bot_profile_provisions'::regclass) then raise exception 'provision RLS is not forced'; end if;
end
$$;
select 'isolated/forced';
delete from organizations where id in (
  '7c000000-0000-4000-8000-000000000001',
  '7d000000-0000-4000-8000-000000000002'
);
