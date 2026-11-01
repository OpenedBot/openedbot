begin;

-- Le backoffice travaille sur les comptes, pas sur la topologie tenant. Cette
-- fonction expose uniquement les champs nécessaires à la liste staff et dit
-- si une session d'assistance peut être ouverte sur un accès encore actif.
create function staff_list_users()
returns table (
  id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  can_impersonate boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  return query
  select u.id,
         u.email,
         u.display_name,
         u.created_at,
         exists (
           select 1
             from public.memberships m
             join public.organizations o on o.id = m.organization_id
            where m.user_id = u.id
              and o.deleted_at is null
         ) as can_impersonate
    from public.users u
   order by u.created_at desc, lower(u.email), u.id;
end;
$$;

revoke all on function staff_list_users() from public;
grant execute on function staff_list_users() to ohb_api;

-- La cible tenant reste un détail du runtime API. Comme la connexion web sans
-- slug, l'impersonation retient le premier accès actif du compte. L'interface
-- staff ne reçoit que l'identité visée et n'a jamais à parcourir les tenants.
create function staff_issue_user_impersonation_claim(
  p_id uuid,
  p_user_id uuid,
  p_claim_token_hash text,
  p_expires_at timestamptz
)
returns table (email text, organization_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  target_email text;
  target_organization_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  select u.email, m.organization_id
    into target_email, target_organization_id
    from public.users u
    join public.memberships m on m.user_id = u.id
    join public.organizations o on o.id = m.organization_id
   where u.id = p_user_id
     and o.deleted_at is null
   order by m.created_at asc, m.organization_id asc
   limit 1;

  if target_email is null or target_organization_id is null then
    return;
  end if;

  insert into public.staff_impersonation_claims (
    id, staff_user_id, organization_id, user_id, claim_token_hash, expires_at
  ) values (
    p_id, staff_id, target_organization_id, p_user_id, p_claim_token_hash, p_expires_at
  );

  return query select target_email, target_organization_id;
end;
$$;

revoke all on function staff_issue_user_impersonation_claim(uuid, uuid, text, timestamptz) from public;
grant execute on function staff_issue_user_impersonation_claim(uuid, uuid, text, timestamptz) to ohb_api;

insert into schema_migrations(version) values ('0030_staff_users')
on conflict (version) do nothing;

commit;
