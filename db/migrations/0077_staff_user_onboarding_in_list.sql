begin;

-- L'ACCUEIL d'un compte, lisible sur la liste et plus seulement sur sa fiche.
--
-- `users.onboarding_completed` existe depuis 0025 et `staff_get_user` (0036,
-- augmenté en 0075) le rend déjà dans l'objet `user` de la fiche. La liste,
-- elle, ne le portait pas : le staff devait ouvrir chaque compte pour savoir
-- lequel s'est arrêté en route. Aucun changement de schéma ici, seulement la
-- colonne qui sort de la fonction de lecture cross-tenant.
--
-- Aucun grant supplémentaire : `users` n'est pas sous RLS et `ohb_api` porte
-- déjà un grant table entier (0001), exactement le raisonnement de 0025 et de
-- 0075.
--
-- Comme en 0075 : la signature de `staff_search_users` ne change pas, mais son
-- type de retour oui, et PostgreSQL refuse un `create or replace` qui modifie
-- une `returns table`. D'où le `drop` puis le `create`. Le corps est celui de
-- 0075_user_last_login, augmenté de `onboarding_completed` ; le préambule de
-- garde sur `app.staff_user_id`, l'échappement du like, les bornes et le
-- curseur keyset `(created_at, lower(email), id)` ne bougent pas d'une ligne.
--
-- Pas de filtre serveur sur cette colonne et pas d'index : la fonction garde
-- ses six paramètres. Le jour où un écran voudra ne montrer que les accueils
-- inachevés, il faudra un septième paramètre ici ET dans le curseur des
-- appelants ; ce n'est pas ce que cette migration fait.
drop function staff_search_users(text, text, int, timestamptz, text, uuid);

create function staff_search_users(
  p_query text default null,
  p_assistance text default null,
  p_limit int default 50,
  p_cursor_created_at timestamptz default null,
  p_cursor_email text default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  last_login_at timestamptz,
  onboarding_completed boolean,
  can_impersonate boolean,
  total_count bigint,
  remaining_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  bounded_limit int;
  needle text;
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

  bounded_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  needle := nullif(btrim(coalesce(p_query, '')), '');
  if needle is not null then
    needle := '%' || replace(replace(replace(lower(needle), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with candidates as (
    select u.id as candidate_id,
           u.email as candidate_email,
           u.display_name as candidate_display_name,
           u.created_at as candidate_created_at,
           u.last_login_at as candidate_last_login_at,
           u.onboarding_completed as candidate_onboarding_completed,
           exists (
             select 1
               from public.memberships m
               join public.organizations o on o.id = m.organization_id
              where m.user_id = u.id
                and o.deleted_at is null
           ) as candidate_can_impersonate
      from public.users u
     where needle is null
        or lower(u.email) like needle escape '\'
        or lower(coalesce(u.display_name, '')) like needle escape '\'
  ),
  filtered as (
    select c.*,
           (
             p_cursor_created_at is null
             or p_cursor_id is null
             or c.candidate_created_at < p_cursor_created_at
             or (c.candidate_created_at = p_cursor_created_at
                 and lower(c.candidate_email) > coalesce(p_cursor_email, ''))
             or (c.candidate_created_at = p_cursor_created_at
                 and lower(c.candidate_email) = coalesce(p_cursor_email, '')
                 and c.candidate_id > p_cursor_id)
           ) as after_cursor
      from candidates c
     where p_assistance is null
        or (p_assistance = 'available' and c.candidate_can_impersonate)
        or (p_assistance = 'unavailable' and not c.candidate_can_impersonate)
  ),
  counted as (
    select count(*) as filter_total,
           count(*) filter (where f.after_cursor) as filter_remaining
      from filtered f
  )
  select f.candidate_id,
         f.candidate_email,
         f.candidate_display_name,
         f.candidate_created_at,
         f.candidate_last_login_at,
         f.candidate_onboarding_completed,
         f.candidate_can_impersonate,
         counted.filter_total,
         counted.filter_remaining
    from filtered f
   cross join counted
   where f.after_cursor
   order by f.candidate_created_at desc, lower(f.candidate_email), f.candidate_id
   limit bounded_limit;
end;
$$;

comment on function staff_search_users(text, text, int, timestamptz, text, uuid) is
  'Page de comptes pour le backoffice staff : recherche e-mail / nom échappée, filtre d''assistance, borne plafonnée à 200 et curseur keyset (created_at, lower(email), id). Rend le total du filtre, le reste à partir du curseur, la dernière connexion du compte (null quand aucune n''a été vue depuis 0075) et l''état de son accueil (users.onboarding_completed, 0025) ; ne remplace jamais une borne par un offset.';

revoke all on function staff_search_users(text, text, int, timestamptz, text, uuid) from public;
grant execute on function staff_search_users(text, text, int, timestamptz, text, uuid) to ohb_api;

insert into schema_migrations(version) values ('0077_staff_user_onboarding_in_list')
on conflict (version) do nothing;

commit;
