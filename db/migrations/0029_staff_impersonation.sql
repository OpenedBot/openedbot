begin;

-- L'impersonation staff n'est jamais une session staff transformée en session
-- tenant. Le staff émet un code à usage unique, puis l'origine de la PWA
-- l'échange contre une vraie session web courte. La colonne portée par la
-- session rend le mode assistance visible au middleware sur chaque requête.
alter table sessions
  add column impersonated_by_staff_user_id uuid references staff_users(id) on delete restrict,
  add constraint sessions_impersonation_web_check
    check (impersonated_by_staff_user_id is null or kind = 'web');

create table staff_impersonation_claims (
  id uuid primary key,
  staff_user_id uuid not null references staff_users(id) on delete restrict,
  -- Identifiants d'audit volontairement détachés : purger un tenant ou un
  -- compte ne doit ni effacer l'événement staff, ni être bloqué par lui.
  organization_id uuid not null,
  user_id uuid not null,
  claim_token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  session_id uuid references sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  check (claimed_at is not null or session_id is null)
);

create index staff_impersonation_claims_staff_idx
  on staff_impersonation_claims (staff_user_id, created_at desc);

alter table staff_impersonation_claims enable row level security;
alter table staff_impersonation_claims force row level security;

-- La route publique d'échange ne connaît que le hash du code one-shot. Elle
-- peut lire et consommer CETTE ligne, jamais énumérer les autres demandes.
create policy staff_impersonation_claim_token on staff_impersonation_claims
  for select to openedbot_api
  using (
    claim_token_hash = nullif(current_setting('app.staff_impersonation_claim_hash', true), '')
  );

create policy staff_impersonation_claim_consume on staff_impersonation_claims
  for update to openedbot_api
  using (
    claim_token_hash = nullif(current_setting('app.staff_impersonation_claim_hash', true), '')
  )
  with check (
    claim_token_hash = nullif(current_setting('app.staff_impersonation_claim_hash', true), '')
  );

grant select, update on staff_impersonation_claims to openedbot_api;

-- Une émission est un seul statement SECURITY DEFINER : l'organisation doit
-- être active et l'utilisateur encore membre au moment précis où le code est
-- créé. L'appelant ne reçoit que l'e-mail public de la cible.
create function staff_issue_impersonation_claim(
  p_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_claim_token_hash text,
  p_expires_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  target_email text;
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

  select u.email
    into target_email
    from public.organizations o
    join public.memberships m on m.organization_id = o.id
    join public.users u on u.id = m.user_id
   where o.id = p_organization_id
     and o.deleted_at is null
     and m.user_id = p_user_id;

  if target_email is null then
    return null;
  end if;

  insert into public.staff_impersonation_claims (
    id, staff_user_id, organization_id, user_id, claim_token_hash, expires_at
  ) values (
    p_id, staff_id, p_organization_id, p_user_id, p_claim_token_hash, p_expires_at
  );

  return target_email;
end;
$$;

revoke all on function staff_issue_impersonation_claim(uuid, uuid, uuid, text, timestamptz) from public;
grant execute on function staff_issue_impersonation_claim(uuid, uuid, uuid, text, timestamptz) to openedbot_api;

-- La fiche staff doit fournir l'identifiant stable utilisé par l'action ;
-- l'e-mail seul n'est ni immuable ni une clé de membre.
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

insert into schema_migrations(version) values ('0029_staff_impersonation')
on conflict (version) do nothing;

commit;
