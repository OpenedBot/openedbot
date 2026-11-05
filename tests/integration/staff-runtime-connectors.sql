-- Preuve 0102 : staff_runtime_connectors() refuse sans GUC staff, puis rend,
-- tous tenants confondus, les seuls runtimes connector non revoques des
-- organisations vivantes, avec leur agent, leur proprietaire actif et le lien.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
-- Tout tient dans une transaction annulee : aucune ligne ne reste.

begin;

create temp table connectors_proof (without_guc text, listed text, owner text, agent text, connected text);
insert into connectors_proof values ('unset', '', '', '', '');
grant select, update on connectors_proof to openedbot_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('80000000-0000-4000-8000-000000000102', 'staff-connectors@example.test', 'x', 'Staff');
insert into organizations (id, slug, name, deleted_at) values
  ('a1020000-0000-4000-8000-000000000001', 'connectors-a', 'Connectors A', null),
  ('a1020000-0000-4000-8000-000000000002', 'connectors-b', 'Connectors B', null),
  ('a1020000-0000-4000-8000-000000000003', 'connectors-gone', 'Connectors Gone', now());
insert into users (id, email, display_name) values
  ('a1020000-0000-4000-8000-000000000011', 'owner-a@connectors.test', 'Owner A'),
  ('a1020000-0000-4000-8000-000000000012', 'member-a@connectors.test', 'Member A');
insert into memberships (organization_id, user_id, role) values
  ('a1020000-0000-4000-8000-000000000001', 'a1020000-0000-4000-8000-000000000012', 'member'),
  ('a1020000-0000-4000-8000-000000000001', 'a1020000-0000-4000-8000-000000000011', 'owner');
insert into runtimes (
  id, organization_id, name, reachability, link_token_hash, link_agent, link_connected_at, revoked_at, is_active
) values
  ('a1020000-0000-4000-8000-000000000021', 'a1020000-0000-4000-8000-000000000001',
   'Old host', 'connector', 'connectors-hash-1', 'edge-setup/v0.5.3', now(), null, false),
  ('a1020000-0000-4000-8000-000000000022', 'a1020000-0000-4000-8000-000000000002',
   'Silent host', 'connector', 'connectors-hash-2', null, null, null, false),
  ('a1020000-0000-4000-8000-000000000023', 'a1020000-0000-4000-8000-000000000002',
   'Revoked host', 'connector', 'connectors-hash-3', 'edge-setup/v0.5.7', null, now(), false),
  ('a1020000-0000-4000-8000-000000000024', 'a1020000-0000-4000-8000-000000000003',
   'Deleted tenant host', 'connector', 'connectors-hash-4', 'edge-setup/v0.5.7', null, null, false);

-- 1. Sans GUC staff, la fonction avorte.
set local role openedbot_api;
select set_config('app.staff_user_id', '', true) \g /dev/null
do $proof$
begin
  perform staff_runtime_connectors();
  update connectors_proof set without_guc = 'leaked';
exception
  when others then
    update connectors_proof set without_guc = 'denied';
end;
$proof$;

-- 2. Staff vivant : les deux tenants, sans le runtime revoque ni le tenant supprime.
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000102', true) \g /dev/null
update connectors_proof set
  listed = (select string_agg(runtime_name, ',' order by runtime_name)
              from staff_runtime_connectors()
             where organization_slug like 'connectors-%'),
  owner = (select coalesce(owner_email, 'none') from staff_runtime_connectors()
            where runtime_id = 'a1020000-0000-4000-8000-000000000021'),
  agent = (select link_agent from staff_runtime_connectors()
            where runtime_id = 'a1020000-0000-4000-8000-000000000021'),
  connected = (select string_agg(connected::text, ',' order by runtime_name)
                 from staff_runtime_connectors()
                where organization_slug like 'connectors-%');

select without_guc || '/' || listed || '/' || owner || '/' || agent || '/' || connected
  from connectors_proof;

rollback;
