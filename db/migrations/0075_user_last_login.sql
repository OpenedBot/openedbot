begin;

-- La DERNIÈRE CONNEXION d'un compte, comme un fait sur la personne.
--
-- Ce que `sessions.last_seen_at` (0001) ne répond pas, et pourquoi cette
-- colonne existe : une session est révoquée, expire et se purge. Le jour où la
-- dernière session d'un compte disparaît, la fiche support perd toute trace de
-- son entrée, et un compte qui s'est connecté hier se lit comme un compte qui
-- ne s'est jamais connecté. `sessions.last_seen_at` reste ce qu'il est, la
-- dernière ACTIVITÉ d'une session vivante ; `users.last_login_at` est la
-- dernière fois qu'une authentification a ouvert une session pour ce compte, et
-- il survit à la session comme à sa purge.
--
-- AUCUN remplissage rétroactif. `max(sessions.last_seen_at)` serait une
-- activité, pas une entrée, et `created_at` serait une date inventée. `null`
-- veut donc dire « aucune connexion vue DEPUIS QUE C'EST MESURÉ », ce que le
-- backoffice affiche comme tel : c'est l'aveu d'une mesure jeune, pas
-- l'accusation d'un compte dormant.
--
-- Comme `onboarding_completed` (0025) : `users` n'est pas sous RLS et `ohb_api`
-- porte déjà un grant table entier (0001), la colonne est donc lisible et
-- modifiable par l'API sans grant supplémentaire. `ohb_worker` ne lit que
-- (id, email) (0002) et n'a rien à faire de cette date.
--
-- Pas d'index : rien ne trie ni ne filtre sur cette colonne. L'ordre servi par
-- `staff_search_users` reste `created_at desc, lower(email), id`, et le jour où
-- un écran voudra trier par dernière connexion, il faudra d'abord décider où
-- tombent les `null`, pas poser un index à l'avance.
alter table users
  add column if not exists last_login_at timestamptz;

comment on column users.last_login_at is
  'Dernière authentification qui a OUVERT une session pour ce compte. Survit à la session et à sa purge, contrairement à sessions.last_seen_at qui date l''activité d''une session vivante. Ni la rotation d''un refresh token natif, ni une session d''assistance staff ne l''écrivent. null = aucune connexion vue depuis que la colonne existe (aucun remplissage rétroactif).';

-- `staff_search_users` doit rendre la colonne : sa signature ne change pas,
-- mais son type de retour oui, et PostgreSQL refuse un `create or replace` qui
-- modifie une `returns table`. Le corps est celui de 0059_staff_user_paging,
-- augmenté de `last_login_at` ; le préambule de garde, l'échappement du like,
-- les bornes et le curseur keyset ne bougent pas d'une ligne.
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
  'Page de comptes pour le backoffice staff : recherche e-mail / nom échappée, filtre d''assistance, borne plafonnée à 200 et curseur keyset (created_at, lower(email), id). Rend le total du filtre, le reste à partir du curseur et la dernière connexion du compte (null quand aucune n''a été vue depuis 0075) ; ne remplace jamais une borne par un offset.';

revoke all on function staff_search_users(text, text, int, timestamptz, text, uuid) from public;
grant execute on function staff_search_users(text, text, int, timestamptz, text, uuid) to ohb_api;

-- La fiche support rend la même date, par le même chemin que tous ses autres
-- champs : dans le jsonb de `staff_get_user`, pas en SQL ad hoc dans la route.
-- Le corps est celui de 0036_staff_user_detail, augmenté de `lastLoginAt` dans
-- l'objet `user`. Les trois interdits de 0036 tiennent : aucun secret runtime,
-- aucune donnée de session appartenant à l'utilisateur (ip, user-agent, hash de
-- jeton), aucun hash de code d'assistance.
create or replace function staff_get_user(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  payload jsonb;
  org_ids uuid[];
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

  if not exists (select 1 from public.users u where u.id = p_id) then
    return null;
  end if;

  -- Périmètre du compte : les organisations dont il est membre. Tout ce qui
  -- suit (runtimes, totaux, activité) est borné par ce tableau.
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
    into org_ids
    from public.memberships m
   where m.user_id = p_id;

  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'displayName', u.display_name,
      'createdAt', u.created_at,
      -- Dernière ENTRÉE du compte, pas l'activité de ses sessions : les deux
      -- cohabitent sur la fiche et ne répondent pas à la même question.
      -- `null` = aucune connexion vue depuis 0075, jamais « jamais connecté ».
      'lastLoginAt', u.last_login_at,
      'onboardingCompleted', u.onboarding_completed,
      -- Même définition que `staff_search_users()` (0059_staff_user_paging.sql) :
      -- un accès encore actif sur une organisation non supprimée.
      'canImpersonate', exists (
        select 1
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
         where m.user_id = u.id
           and o.deleted_at is null
      )
    ),
    'organizations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', o.id,
          'slug', o.slug,
          'name', o.name,
          'role', m.role,
          'joinedAt', m.created_at,
          'memberCount', (
            select count(*) from public.memberships m2 where m2.organization_id = o.id
          ),
          'botCount', (
            select count(*) from public.bots b
             where b.organization_id = o.id and b.deleted_at is null
          ),
          'subscriptionStatus', (
            select s.status from public.subscriptions s where s.organization_id = o.id
          ),
          'deletedAt', o.deleted_at
        )
        order by m.created_at
      )
      from public.memberships m
      join public.organizations o on o.id = m.organization_id
      where m.user_id = u.id
    ), '[]'::jsonb),
    'runtimes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'organizationId', r.organization_id,
          -- L'hôte seul, jamais l'URL complète ni un jeton.
          'endpointHost', (regexp_match(r.endpoint, '^https?://([^/?#]+)'))[1],
          'name', r.name,
          'health', r.last_health_status,
          'reachability', r.reachability,
          'isActive', r.is_active,
          'revokedAt', r.revoked_at,
          'linkConnectedAt', r.link_connected_at,
          'linkLastSeenAt', r.link_last_seen_at,
          'lastCheckedAt', r.last_probed_at
        )
        order by r.created_at
      )
      from public.runtimes r
      where r.organization_id = any(org_ids)
    ), '[]'::jsonb),
    'sessions', (
      select jsonb_build_object(
        -- « Active » = non révoquée et pas encore expirée.
        'active', count(*) filter (
          where s.revoked_at is null
            and greatest(s.access_expires_at, coalesce(s.refresh_expires_at, s.access_expires_at)) > now()
        ),
        'total', count(*),
        'lastSeenAt', max(s.last_seen_at),
        'recent', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', recent.id,
              'kind', recent.kind,
              'createdAt', recent.created_at,
              'lastSeenAt', recent.last_seen_at,
              'revokedAt', recent.revoked_at,
              'impersonated', recent.impersonated_by_staff_user_id is not null
            )
            order by recent.created_at desc
          )
          from (
            select s2.id, s2.kind, s2.created_at, s2.last_seen_at, s2.revoked_at,
                   s2.impersonated_by_staff_user_id
              from public.sessions s2
             where s2.user_id = u.id
             order by s2.created_at desc
             limit 10
          ) recent
        ), '[]'::jsonb)
      )
      from public.sessions s
      where s.user_id = u.id
    ),
    'assistance', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'createdAt', claim.created_at,
          'claimedAt', claim.claimed_at,
          'expiresAt', claim.expires_at,
          'organizationId', claim.organization_id,
          'staffUserId', claim.staff_user_id,
          'staffDisplayName', claim.staff_display_name,
          'staffEmail', claim.staff_email
        )
        order by claim.created_at desc
      )
      from (
        select c.created_at, c.claimed_at, c.expires_at, c.organization_id,
               c.staff_user_id, su.display_name as staff_display_name, su.email as staff_email
          from public.staff_impersonation_claims c
          join public.staff_users su on su.id = c.staff_user_id
         where c.user_id = u.id
         order by c.created_at desc
         limit 10
      ) claim
    ), '[]'::jsonb),
    -- ATTENTION : ceci est l'activité des ORGANISATIONS du compte, pas celle
    -- de l'utilisateur. `messages` ne porte que `role` / `author_bot_id` et
    -- `runs` n'a ni `user_id` ni `created_by` : aucune ligne n'est attribuable
    -- à un membre précis. Une organisation à plusieurs membres agrège donc le
    -- travail de tous. Ne pas renommer ce champ en « activité utilisateur ».
    'organizationActivity', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'day', to_char(d.day, 'YYYY-MM-DD'),
          'messages', a.messages,
          'runs', a.runs,
          'threads', a.threads
        )
        order by d.day
      )
      from (
        select gs::date as day
          from generate_series(current_date - 29, current_date, interval '1 day') gs
      ) d
      cross join lateral (
        select
          (select count(*) from public.messages msg
            where msg.organization_id = any(org_ids)
              and msg.created_at >= d.day::timestamptz
              and msg.created_at < (d.day + 1)::timestamptz) as messages,
          (select count(*) from public.runs rn
            where rn.organization_id = any(org_ids)
              and rn.created_at >= d.day::timestamptz
              and rn.created_at < (d.day + 1)::timestamptz) as runs,
          (select count(*) from public.threads th
            where th.organization_id = any(org_ids)
              and th.created_at >= d.day::timestamptz
              and th.created_at < (d.day + 1)::timestamptz) as threads
      ) a
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'organizations', coalesce(array_length(org_ids, 1), 0),
      'runtimes', (select count(*) from public.runtimes r where r.organization_id = any(org_ids)),
      'bots', (
        select count(*) from public.bots b
         where b.organization_id = any(org_ids) and b.deleted_at is null
      ),
      'threads', (select count(*) from public.threads t where t.organization_id = any(org_ids)),
      'messages', (select count(*) from public.messages m3 where m3.organization_id = any(org_ids)),
      'runs', (select count(*) from public.runs r2 where r2.organization_id = any(org_ids))
    ),
    -- Faits analytiques réellement attribués à ce compte (`actor_id`). La
    -- série reste vide tant que l'émission n'est pas câblée : c'est la
    -- vérité, on ne la remplace pas par un proxy.
    'analytics', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'day', to_char(ev.day, 'YYYY-MM-DD'),
          'name', ev.name,
          'count', ev.count
        )
        order by ev.day, ev.name
      )
      from (
        select (e.occurred_at at time zone 'UTC')::date as day, e.name, count(*) as count
          from public.analytics_events e
         where e.actor_id = u.id
           and e.occurred_at >= (current_date - 29)::timestamptz
         group by 1, 2
      ) ev
    ), '[]'::jsonb)
  )
  into payload
  from public.users u
  where u.id = p_id;

  return payload;
end;
$$;

comment on function staff_get_user(uuid) is
  'Fiche staff d''un compte utilisateur. Rend la dernière connexion du compte (users.last_login_at), distincte de l''activité de ses sessions. `organizationActivity` agrège les organisations du compte : `messages` et `runs` ne portent aucun auteur utilisateur, l''activité n''est donc PAS attribuable à un membre précis. N''expose ni secret runtime, ni ip / user-agent / hash de jeton de session, ni hash de code d''assistance.';

revoke all on function staff_get_user(uuid) from public;
grant execute on function staff_get_user(uuid) to ohb_api;

insert into schema_migrations(version) values ('0075_user_last_login')
on conflict (version) do nothing;

commit;
