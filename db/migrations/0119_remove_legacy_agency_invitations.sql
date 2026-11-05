-- Retire the unused member-invitation path after agency mandates replaced it.
begin;
do $$
begin
  if exists (select 1 from organization_invitations) then
    raise exception 'Legacy organization invitations are not empty; migrate them explicitly before cleanup';
  end if;
  if exists (select 1 from pg_constraint where contype = 'f' and confrelid = 'organization_invitations'::regclass) then
    raise exception 'Legacy organization invitations still have incoming foreign keys';
  end if;
  if exists (select 1 from memberships where role = 'agency' and revoked_at is null) then
    raise exception 'Live agency memberships must be converted to mandates before cleanup';
  end if;
end $$;
-- 0086 retained revoked legacy memberships for foreign-key history. Keep those
-- rows revoked; their original agency role remains in membership_events.
update memberships set role = 'member' where role = 'agency' and revoked_at is not null;
alter table memberships drop constraint if exists memberships_agency_revoked;
alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check check (role in ('owner', 'admin', 'member'));
drop table organization_invitations;
create or replace function workspace_access(p_user uuid, p_org uuid)
returns table (role text, kind text, via_agency_ids uuid[])
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with target as (
    select o.id, o.kind from public.organizations o
     where o.id = p_org and o.deleted_at is null
  ),
  direct as (
    select m.role from public.memberships m
      join target t on t.id = m.organization_id
     where m.user_id = p_user and m.revoked_at is null
  ),
  delegated as (
    select array_agg(distinct g.agency_organization_id) as ids
      from public.agency_grants g
      join target t on t.id = g.client_organization_id and t.kind = 'personal'
      join public.organizations a on a.id = g.agency_organization_id
        and a.kind = 'agency' and a.deleted_at is null
      join public.memberships am on am.organization_id = a.id
        and am.user_id = p_user and am.revoked_at is null and am.role in ('owner', 'admin', 'member')
     where g.revoked_at is null
  )
  select coalesce(
           (select d.role from direct d limit 1),
           case when (select ids from delegated) is not null then 'agency' end
         ),
         t.kind,
         coalesce((select ids from delegated), '{}'::uuid[])
    from target t;
$$;
revoke all on function workspace_access(uuid, uuid) from public;
grant execute on function workspace_access(uuid, uuid) to openedbot_api;

insert into schema_migrations(version) values ('0119_remove_legacy_agency_invitations') on conflict do nothing;
commit;
