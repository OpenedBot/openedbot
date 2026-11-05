-- Personnel et Agence deviennent deux TYPES d'organisation.
--
-- Jusqu'ici l'agence n'existait pas comme tenant : une préférence de compte
-- (`account_preferences`, 0083) et un rôle `agency` posé PAR UTILISATEUR dans
-- `memberships` de chaque client. L'agence n'avait ni équipe, ni abonnement,
-- ni identité propre.
--
-- Cible :
--
--   1. `organizations.kind` vaut `personal` ou `agency` ;
--   2. un client accorde l'accès à une ORGANISATION agence (`agency_grants`),
--      et tous les membres vivants de cette agence en héritent ;
--   3. `workspace_access(user, org)` est la seule définition de l'accès :
--      membership directe, sinon grant vivant depuis une agence dont
--      l'utilisateur est membre (rôle dérivé `agency`) ;
--   4. une seule organisation personnelle par utilisateur, tenue en SQL
--      (`personal_owner_user_id` unique) et non par une lecture applicative
--      qu'une course de deux POST contournerait.
--
-- Les données existantes sont converties SANS suppression : `approval_requests`
-- et `decisions` (0007) référencent `memberships` sans cascade, d'autres tables
-- la référencent en cascade (0004, 0005, 0039). Une membership `agency` est
-- donc révoquée (`revoked_at`), jamais supprimée, et l'historique reste lisible.
--
-- `account_preferences` n'est plus lue par le code mais reste en base : les
-- migrations passent avant le redémarrage applicatif (`scripts/db.sh`), et
-- l'instance précédente doit survivre à ce fichier. Son retrait est une
-- migration de la release suivante.
--
-- `agency_grants` ne reçoit AUCUNE policy `openedbot_worker` : le worker n'en a pas
-- besoin (la purge d'une organisation retire ses grants par cascade), et la
-- liste des exceptions worker (`tests/integration/postgres-rls.sh`) ne s'allonge pas.
begin;

-- 1. Types d'organisation.
alter table organizations add column if not exists kind text not null default 'personal';
alter table organizations drop constraint if exists organizations_kind_check;
alter table organizations add constraint organizations_kind_check check (kind in ('personal', 'agency'));

alter table organizations add column if not exists personal_owner_user_id uuid references users(id) on delete set null;
alter table organizations drop constraint if exists organizations_personal_owner_unique;
alter table organizations add constraint organizations_personal_owner_unique unique (personal_owner_user_id);
alter table organizations drop constraint if exists organizations_personal_owner_kind;
alter table organizations add constraint organizations_personal_owner_kind
  check (kind = 'personal' or personal_owner_user_id is null);

-- 2. Grants agence -> client.
create table if not exists agency_grants (
  id uuid primary key,
  agency_organization_id uuid not null references organizations(id) on delete cascade,
  client_organization_id uuid not null references organizations(id) on delete cascade,
  granted_by_user_id uuid references users(id) on delete set null,
  revoked_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint agency_grants_distinct_organizations check (agency_organization_id <> client_organization_id)
);
create unique index if not exists agency_grants_live_pair
  on agency_grants (agency_organization_id, client_organization_id) where revoked_at is null;
create index if not exists agency_grants_client_live
  on agency_grants (client_organization_id) where revoked_at is null;

alter table agency_grants enable row level security;
alter table agency_grants force row level security;
drop policy if exists agency_grants_tenant on agency_grants;
create policy agency_grants_tenant on agency_grants to openedbot_api
  using (
    agency_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or client_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  )
  with check (
    agency_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or client_organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );
grant select, insert, update on agency_grants to openedbot_api;

-- L'invitation d'une agence garde la mémoire de l'agence qui l'a acceptée :
-- un rejeu rend le même grant au lieu d'en chercher un autre.
alter table organization_invitations add column if not exists accepted_agency_organization_id uuid
  references organizations(id) on delete set null;

-- 3. Journal d'accès : le sujet d'un grant est une organisation.
alter table membership_events add column if not exists subject_organization_id uuid;
alter table membership_events drop constraint if exists membership_events_kind_check;
alter table membership_events add constraint membership_events_kind_check
  check (kind in ('invited', 'accepted', 'role_changed', 'revoked', 'agency_granted', 'agency_revoked'));

-- 4. La définition unique de l'accès à un espace.
--
-- `security definer` : la question traverse deux tenants (l'agence et le
-- client), ce qu'aucune policy par `app.organization_id` ne permet. La fonction
-- ne rend que trois faits sur le couple demandé, jamais une liste.
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
     where m.user_id = p_user and m.revoked_at is null and m.role <> 'agency'
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

-- 5. Feature pilotée depuis l'admin : l'abonnement propre d'une agence.
insert into product_features (feature_key, enabled) values ('agency_billing', false)
on conflict (feature_key) do nothing;
grant insert, update on product_features to openedbot_api;

-- 6. Conversion des données.
do $$
declare
  account record;
  client record;
  agency_id uuid;
  client_owner uuid;
  display text;
  base text;
  candidate text;
  attempt integer;
begin
  -- 6a. L'organisation personnelle d'un utilisateur : seulement quand elle est
  -- sans ambiguïté (un seul owner vivant, qui n'est owner d'aucune autre).
  update organizations o set personal_owner_user_id = owners.user_id
    from (
      select m.organization_id, m.user_id
        from memberships m
        join organizations x on x.id = m.organization_id and x.deleted_at is null and x.kind = 'personal'
       where m.role = 'owner' and m.revoked_at is null
    ) owners
   where owners.organization_id = o.id
     and o.personal_owner_user_id is null
     and (select count(*) from memberships m2
           where m2.organization_id = o.id and m2.role = 'owner' and m2.revoked_at is null) = 1
     and (select count(*) from memberships m3
            join organizations y on y.id = m3.organization_id and y.deleted_at is null and y.kind = 'personal'
           where m3.user_id = owners.user_id and m3.role = 'owner' and m3.revoked_at is null) = 1
     and not exists (select 1 from organizations z where z.personal_owner_user_id = owners.user_id);

  -- 6b. Une organisation agence par opérateur agence existant.
  for account in
    select u.id, u.email, u.display_name
      from users u
     where exists (select 1 from account_preferences p where p.user_id = u.id and p.agency_enabled)
        or exists (select 1 from memberships m where m.user_id = u.id and m.role = 'agency' and m.revoked_at is null)
     order by u.created_at, u.id
  loop
    select o.id into agency_id
      from organizations o
      join memberships m on m.organization_id = o.id
     where o.kind = 'agency' and o.deleted_at is null
       and m.user_id = account.id and m.role = 'owner' and m.revoked_at is null
     order by o.created_at, o.id
     limit 1;

    if agency_id is null then
      agency_id := gen_random_uuid();
      display := coalesce(nullif(btrim(account.display_name), ''), split_part(account.email, '@', 1)) || ' Agence';
      -- Même fabrique de slug que 0085 : base normalisée, puis fin d'UUID.
      base := regexp_replace(
        translate(lower(display), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
        '[^a-z0-9]+', '-', 'g');
      base := btrim(left(btrim(base, '-'), 40), '-');
      if base = '' then base := 'agence'; end if;
      attempt := 0;
      loop
        candidate := case attempt
          when 0 then base
          when 1 then base || '-' || right(replace(agency_id::text, '-', ''), 12)
          else base || '-' || right(replace(agency_id::text, '-', ''), 12) || '-' || attempt
        end;
        exit when not exists (select 1 from organizations where slug = candidate);
        attempt := attempt + 1;
      end loop;
      insert into organizations (id, slug, name, kind) values (agency_id, candidate, left(display, 80), 'agency');
      insert into memberships (organization_id, user_id, role) values (agency_id, account.id, 'owner');
    end if;

    -- 6c. Chaque accès client devient un grant de cette agence. L'accès ne
    -- s'interrompt pas : routines et abonnements push de l'opérateur restent,
    -- puisqu'il garde l'accès par le grant.
    for client in
      select m.organization_id, m.created_at
        from memberships m
       where m.user_id = account.id and m.role = 'agency' and m.revoked_at is null
       order by m.created_at
    loop
      select m2.user_id into client_owner
        from memberships m2
       where m2.organization_id = client.organization_id and m2.role = 'owner' and m2.revoked_at is null
       order by m2.created_at
       limit 1;
      insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id, created_at)
      values (gen_random_uuid(), agency_id, client.organization_id, client_owner, client.created_at)
      on conflict (agency_organization_id, client_organization_id) where revoked_at is null do nothing;
      update memberships set revoked_at = now()
       where organization_id = client.organization_id and user_id = account.id and revoked_at is null;
      insert into membership_events (id, organization_id, actor_user_id, subject_user_id, subject_organization_id, kind, role)
      values (gen_random_uuid(), client.organization_id, coalesce(client_owner, account.id), account.id,
              agency_id, 'agency_granted', 'agency');
    end loop;
  end loop;
end $$;

-- 7. Plus aucun rôle `agency` vivant : l'accès agence ne passe que par un grant.
alter table memberships drop constraint if exists memberships_agency_revoked;
alter table memberships add constraint memberships_agency_revoked
  check (role <> 'agency' or revoked_at is not null);

-- 8. Backoffice : le type d'organisation et les grants sont visibles.

-- staff_get_organization : 0029 + `kind` + `agencyGrants`.
create or replace function staff_get_organization(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  payload jsonb;
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

  select jsonb_build_object(
    'id', o.id,
    'slug', o.slug,
    'name', o.name,
    'kind', o.kind,
    'createdAt', o.created_at,
    'deletedAt', o.deleted_at,
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'userId', u.id,
          'email', u.email,
          'displayName', u.display_name,
          'role', m.role
        )
        order by m.created_at
      )
      from public.memberships m
      join public.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'::jsonb),
    'agencyGrants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', g.id,
          'agencyOrganizationId', g.agency_organization_id,
          'clientOrganizationId', g.client_organization_id,
          'counterpartName', counterpart.name,
          'createdAt', g.created_at,
          'revokedAt', g.revoked_at
        )
        order by g.created_at desc
      )
      from public.agency_grants g
      join public.organizations counterpart
        on counterpart.id = case when g.agency_organization_id = o.id
                                 then g.client_organization_id else g.agency_organization_id end
      where g.agency_organization_id = o.id or g.client_organization_id = o.id
    ), '[]'::jsonb),
    'subscription', (
      select jsonb_build_object(
        'status', s.status,
        'runtimeLimit', s.runtime_limit,
        'memberLimit', s.member_limit,
        'concurrentRunLimit', s.concurrent_run_limit,
        'attachmentQuotaBytes', s.attachment_quota_bytes,
        'currentPeriodEnd', s.current_period_end,
        'stripeCustomerId', s.stripe_customer_id
      )
      from public.subscriptions s
      where s.organization_id = o.id
    ),
    'runtimes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'name', r.name,
          'endpointHost', (regexp_match(r.endpoint, '^https?://([^/?#]+)'))[1],
          'health', r.last_health_status,
          'lastCheckedAt', r.last_probed_at
        )
        order by r.created_at
      )
      from public.runtimes r
      where r.organization_id = o.id
    ), '[]'::jsonb),
    'tenantDeletion', (
      select jsonb_build_object(
        'reason', d.reason,
        'requestedAt', d.requested_at,
        'purgeAfter', d.purge_after,
        'startedAt', d.started_at,
        'completedAt', d.completed_at
      )
      from public.tenant_deletions d
      where d.organization_id = o.id
    )
  )
  into payload
  from public.organizations o
  where o.id = p_id;

  return payload;
end;
$$;
revoke all on function staff_get_organization(uuid) from public;
grant execute on function staff_get_organization(uuid) to openedbot_api;

-- staff_get_user : 0075 + `kind` sur chaque organisation.
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
          'kind', o.kind,
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
revoke all on function staff_get_user(uuid) from public;
grant execute on function staff_get_user(uuid) to openedbot_api;

insert into schema_migrations(version) values ('0086_organization_kinds') on conflict (version) do nothing;

commit;
