begin;

-- Backoffice staff : la version du connecteur `edge-setup` déclarée par chaque
-- runtime `connector` non révoqué, tous tenants confondus, pour que l'équipe
-- prévienne le propriétaire d'un connecteur périmé. OHB ne met jamais l'hôte
-- à jour lui-même : il ne peut que nommer la commande à lancer.
--
-- Lecture seule. Même garde que `staff_runtime_link_alerts` (0087) : la
-- fonction est `security definer` et n'ouvre rien sans un `app.staff_user_id`
-- vivant, que seul `withStaffUser` pose. Le seuil de version vit dans
-- l'environnement de l'API, pas en base : la comparaison se fait côté route.
-- Aucun jeton, aucune empreinte, aucune clé device ne traverse.
create or replace function staff_runtime_connectors(p_limit int default 2000)
returns table (
  runtime_id uuid,
  runtime_name text,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  owner_user_id uuid,
  owner_email text,
  owner_name text,
  link_agent text,
  link_agent_seen_at timestamptz,
  link_last_seen_at timestamptz,
  connected boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query
    select r.id, r.name, o.id, o.name, o.slug,
           ow.id, ow.email, ow.display_name,
           r.link_agent, r.link_agent_seen_at, r.link_last_seen_at,
           r.link_connected_at is not null
      from public.runtimes r
      join public.organizations o on o.id = r.organization_id
      left join lateral (
        select u.id, u.email, u.display_name
          from public.memberships m
          join public.users u on u.id = m.user_id
         where m.organization_id = o.id
           and m.role = 'owner'
           and m.revoked_at is null
         order by m.created_at
         limit 1
      ) ow on true
     where r.reachability = 'connector'
       and r.revoked_at is null
       and o.deleted_at is null
     order by o.name, r.name, r.id
     limit greatest(1, least(coalesce(p_limit, 2000), 2000));
end;
$$;

comment on function staff_runtime_connectors(int) is
  'Runtimes connector non révoqués des organisations vivantes, avec la version déclarée du connecteur (link_agent), le premier propriétaire actif et l''état du lien. Lecture staff seule, `p_limit` borné à 2000.';

revoke all on function staff_runtime_connectors(int) from public;
grant execute on function staff_runtime_connectors(int) to ohb_api;

insert into schema_migrations(version) values ('0102_staff_runtime_connectors');
commit;
