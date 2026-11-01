-- Staff backoffice: tenant RLS stays closed, SECURITY DEFINER opens both
-- tenants only when app.staff_user_id is a live staff user.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table staff_proof (
  own_orgs int,
  other_orgs int,
  without_guc text,
  with_guc int,
  staff_role text
);
insert into staff_proof values (-1, -1, 'unset', -1, 'missing');

insert into staff_users (id, email, password_hash, display_name) values
  ('80000000-0000-4000-8000-000000000081', 'staff@example.test', 'x', 'Staff');

grant select, insert, update on staff_proof to ohb_api;

-- 1-2. Tenant GUC alone: still one own org, zero of the other.
set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
select set_config('app.staff_user_id', '', false) \g /dev/null
update staff_proof
   set own_orgs = (select count(*) from organizations),
       other_orgs = (select count(*) from organizations where id = '20000000-0000-4000-8000-000000000002');
reset role;

-- 3. The cross-tenant function without a staff GUC must abort.
--
-- La sonde est staff_get_organization(uuid) depuis 0060 : la liste
-- staff_list_organizations() a ete supprimee avec sa derniere route, parce qu
-- une liste d organisations EST la navigation par organisation que le
-- backoffice n a pas. Le detail par identifiant reste, il porte la meme garde.
set role ohb_api;
do $staff$
begin
  perform staff_get_organization('10000000-0000-4000-8000-000000000001');
  update staff_proof set without_guc = 'leaked';
exception
  when others then
    update staff_proof set without_guc = 'denied';
end;
$staff$;
reset role;

-- 4. Live staff user: both tenants.
set role ohb_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000081', false) \g /dev/null
update staff_proof
   set with_guc = (
     select count(*)
       from (values
         (staff_get_organization('10000000-0000-4000-8000-000000000001')),
         (staff_get_organization('20000000-0000-4000-8000-000000000002'))
       ) as reachable(payload)
      where payload is not null
   );
reset role;

-- 5. Role exists for later use; V1 still executes definers as ohb_api.
update staff_proof
   set staff_role = case
     when exists (select 1 from pg_roles where rolname = 'ohb_staff' and rolcanlogin) then 'login'
     else 'missing'
   end;

select own_orgs || '/' || other_orgs || '/' || without_guc || '/' || with_guc || '/' || staff_role
  from staff_proof;
