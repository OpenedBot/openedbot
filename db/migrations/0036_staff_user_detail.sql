begin;

-- Fiche staff d'un compte utilisateur. Le backoffice reste centré sur le
-- compte : les organisations n'apparaissent que parce qu'un compte n'a pas de
-- sens hors d'elles, jamais comme une navigation par organisation
-- (`docs/cloud/ADMIN.md`). Aucun contenu de conversation n'est lu ici.
--
-- Le préambule de garde est celui de `staff_operational_metrics()`
-- (0023_staff.sql) : mot pour mot, y compris l'exception sur un
-- `app.staff_user_id` illisible.
--
-- Ce que la fonction n'expose PAS, volontairement :
--   * aucun secret runtime (`token_ciphertext`, `token_nonce`, `token_tag`,
--     `token_key_id`, `link_token_hash`) ; du runtime ne sort que l'HÔTE de
--     l'endpoint, comme `staff_get_organization()` ;
--   * aucune donnée de session appartenant à l'utilisateur (`ip`,
--     `user_agent`, hash de jeton) : c'est sa vie privée, pas du diagnostic ;
--   * aucun `claim_token_hash` d'assistance.
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
      'onboardingCompleted', u.onboarding_completed,
      -- Même définition que `staff_list_users()` (0030_staff_users.sql) :
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
  'Fiche staff d''un compte utilisateur. `organizationActivity` agrège les organisations du compte : `messages` et `runs` ne portent aucun auteur utilisateur, l''activité n''est donc PAS attribuable à un membre précis. N''expose ni secret runtime, ni ip / user-agent / hash de jeton de session, ni hash de code d''assistance.';

revoke all on function staff_get_user(uuid) from public;
grant execute on function staff_get_user(uuid) to ohb_api;

insert into schema_migrations(version) values ('0036_staff_user_detail')
on conflict (version) do nothing;

commit;
