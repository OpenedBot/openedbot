begin;

-- Liste des comptes du backoffice : pagination, recherche et compteurs côté
-- serveur.
--
-- Pourquoi `staff_list_users()` disparaît au lieu de cohabiter avec la
-- nouvelle fonction : elle n'avait ni borne ni filtre et rendait TOUS les
-- comptes. Tant qu'elle existe, un appelant peut la reprendre et ramener la
-- base entière dans le backoffice ; la garder « au cas où » aurait donc
-- conservé exactement le défaut que cette migration corrige. Elle n'a qu'un
-- appelant (`GET /api/staff/users`), qui suit dans le même lot.
--
-- Le préambule de garde est celui de `staff_list_users()` (0030_staff_users.sql),
-- mot pour mot : lecture de `app.staff_user_id`, `invalid_text_representation`
-- capturée, refus `42501` si le staff est absent ou désactivé.

drop function staff_list_users();

-- Pagination KEYSET, jamais `offset`. L'ordre servi est
-- `created_at desc, lower(email), id` : le curseur est donc ce triplet et rien
-- d'autre. Un `offset` sur cet ordre saute ou répète une ligne dès que deux
-- comptes partagent `created_at`, et un curseur réduit au seul `created_at`
-- fait la même chose entre deux comptes créés dans la même milliseconde.
--
-- Deux compteurs sont rendus sur chaque ligne :
--   * `total_count`    : le total du filtre, curseur ignoré, pour que
--                        l'interface sache combien de pages elle a ;
--   * `remaining_count`: ce qui reste À PARTIR du curseur. L'appelant n'émet
--                        un curseur suivant que si `remaining_count` dépasse
--                        la page servie, ce qui interdit d'atterrir sur une
--                        page vide quand le total est un multiple exact de la
--                        borne.
--
-- La recherche compare l'e-mail et le nom affiché, insensible à la casse, et
-- échappe `%`, `_` et `\` : un terme « 100% » cherche bien ces quatre
-- caractères, pas « 100 suivi de n'importe quoi ». Le balayage reste séquentiel
-- (un `like '%…%'` n'utilise aucun index B-tree) ; c'est tenable parce que la
-- borne plafonne le transport, et un index trigramme se posera le jour où le
-- volume le demandera.
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
  'Page de comptes pour le backoffice staff : recherche e-mail / nom échappée, filtre d''assistance, borne plafonnée à 200 et curseur keyset (created_at, lower(email), id). Rend le total du filtre et le reste à partir du curseur ; ne remplace jamais une borne par un offset.';

revoke all on function staff_search_users(text, text, int, timestamptz, text, uuid) from public;
grant execute on function staff_search_users(text, text, int, timestamptz, text, uuid) to ohb_api;

-- Compteurs du tableau de bord. Ils existent pour que l'écran d'accueil cesse
-- de charger la liste complète pour afficher trois nombres : le prédicat
-- d'assistance est exactement celui de `can_impersonate` ci-dessus, pour que
-- les deux écrans ne racontent pas deux histoires.
create function staff_user_counts()
returns table (
  total_count bigint,
  signups_7d bigint,
  signups_30d bigint,
  impersonable_count bigint,
  last_created_at timestamptz
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
  select count(*)::bigint,
         count(*) filter (where u.created_at >= now() - interval '7 days')::bigint,
         count(*) filter (where u.created_at >= now() - interval '30 days')::bigint,
         count(*) filter (
           where exists (
             select 1
               from public.memberships m
               join public.organizations o on o.id = m.organization_id
              where m.user_id = u.id
                and o.deleted_at is null
           )
         )::bigint,
         max(u.created_at)
    from public.users u;
end;
$$;

comment on function staff_user_counts() is
  'Compteurs de comptes du tableau de bord staff : total, inscriptions à 7 et 30 jours, comptes avec un accès actif (même prédicat que can_impersonate) et date du dernier compte créé.';

revoke all on function staff_user_counts() from public;
grant execute on function staff_user_counts() to ohb_api;

-- Résolution d'un identifiant pour l'omnibox du backoffice.
--
-- Ce que la fonction rend : le TYPE reconnu, le compte à ouvrir quand il en
-- existe un, un libellé et le contexte de l'identifiant. Ce qu'elle ne rend
-- JAMAIS : un contenu de message, un titre de fil, une entrée ou une sortie de
-- run. Un fil se résout à son organisation et aux comptes qui y ont accès,
-- jamais à son texte ; c'est la raison pour laquelle `threads.title`,
-- `runs.input` et `runs.output` n'apparaissent nulle part ci-dessous.
--
-- `user_id` nul signifie « identifiant reconnu, aucun compte derrière » : une
-- organisation sans membre reste une réponse utile, elle ne doit pas se
-- présenter comme une absence de résultat.
--
-- Aucune branche pour un `requestId` : `docs/cloud/ANALYTICS.md` pose que le
-- log technique part sur stdout vers un collecteur hors application. Aucune
-- table ne l'indexe, donc aucune requête ne peut le trouver ; l'interface le
-- dit à l'écran plutôt que de balayer la base pour rien.
create function staff_resolve_reference(p_term text)
returns table (
  kind text,
  user_id uuid,
  label text,
  context text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  term text;
  as_uuid uuid;
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

  term := nullif(btrim(coalesce(p_term, '')), '');
  if term is null then
    return;
  end if;

  begin
    as_uuid := term::uuid;
  exception
    when invalid_text_representation then
      as_uuid := null;
  end;

  if as_uuid is not null then
    return query
    select 'user'::text,
           u.id,
           coalesce(nullif(btrim(u.display_name), ''), u.email),
           u.email
      from public.users u
     where u.id = as_uuid;

    return query
    select 'organization'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           o.name || ' (' || o.slug || ')'
      from public.organizations o
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where o.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return query
    select 'runtime'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, r.name),
           r.name || ' | ' || o.name
      from public.runtimes r
      join public.organizations o on o.id = r.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where r.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return query
    select 'run'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           'run ' || rn.status || ' | ' || o.name
      from public.runs rn
      join public.organizations o on o.id = rn.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where rn.id = as_uuid
     order by mu.email nulls first
     limit 10;

    -- Le fil ne sort que par son organisation : ni `title`, ni
    -- `hermes_session_id`, ni un compte de messages.
    return query
    select 'thread'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           o.name
      from public.threads t
      join public.organizations o on o.id = t.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where t.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return;
  end if;

  needle := '%' || replace(replace(replace(lower(term), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select 'user'::text,
         u.id,
         coalesce(nullif(btrim(u.display_name), ''), u.email),
         u.email
    from public.users u
   where lower(u.email) like needle escape '\'
      or lower(coalesce(u.display_name, '')) like needle escape '\'
   order by lower(u.email)
   limit 10;
end;
$$;

comment on function staff_resolve_reference(text) is
  'Omnibox du backoffice staff : résout un e-mail, un fragment d''e-mail ou un identifiant de compte, d''organisation, de runtime, de run ou de fil vers le compte à ouvrir. Ne rend jamais de contenu de message ni de titre de fil. Aucun requestId : le log technique vit chez le collecteur, hors base.';

revoke all on function staff_resolve_reference(text) from public;
grant execute on function staff_resolve_reference(text) to ohb_api;

insert into schema_migrations(version) values ('0059_staff_user_paging')
on conflict (version) do nothing;

commit;
