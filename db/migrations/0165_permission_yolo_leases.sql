-- Mode YOLO (PR 2/8) : le bail signé et daté qui laisse l'HÔTE auto-approuver
-- les demandes d'un thread, d'un bot ou d'un runtime, hors liste hardline,
-- deny-list d'organisation et protections (domaine : PR 1,
-- `modules/execution/src/domain/yolo-lease.ts`).
--
-- Trois tables :
--   * permission_yolo_leases : un bail par ligne, sa charge utile canonique
--     signée (`payload`, `key_id`, `signature`) et ce que l'hôte en a dit.
--     Les colonnes de portée et de fenêtre sont DÉRIVÉES de la charge signée
--     par `grant_permission_yolo_lease` : la ligne ne peut pas dire autre
--     chose que le bail.
--   * permission_yolo_audit : l'audit local des auto-approbations que l'hôte
--     remonte (PR 4) ; le hash des arguments seulement, jamais les arguments.
--     Append-only.
--   * permission_yolo_consents : la confirmation donnée la première fois, et
--     le YOLO par défaut du mode solo (PR 7).
--
-- Un bot ne s'octroie jamais un bail : `granted_by_user_id` référence un
-- utilisateur, et l'unique chemin d'écriture vérifie un membre owner ou admin
-- vivant de l'organisation liée à la transaction (calque de
-- `set_organization_permission_policy`, 0142). Aucun rôle applicatif n'a
-- DELETE ; une ligne ne part qu'avec son organisation.
begin;

create table permission_yolo_leases (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  scope text not null check (scope in ('thread', 'bot', 'runtime')),
  bot_id uuid,
  thread_id uuid,
  -- Slug Hermes du bot (bot, thread) ; hex(sha256(session Hermes)) (thread).
  profile text check (profile is null or char_length(profile) between 1 and 128),
  session_key text check (session_key is null or session_key ~ '^[0-9a-f]{64}$'),
  granted_by_user_id uuid not null references users(id),
  issued_at timestamptz not null,
  not_before timestamptz not null,
  expires_at timestamptz not null,
  key_id text not null check (key_id ~ '^[0-9a-f]{32}$'),
  signature text not null check (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  delivered_at timestamptz,
  host_state text not null default 'pending'
    check (host_state in ('pending', 'active', 'expired', 'revoked', 'rejected')),
  host_state_reason text check (host_state_reason is null or host_state_reason ~ '^[a-z_]{1,64}$'),
  host_state_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid references users(id),
  revoke_reason text check (revoke_reason is null or revoke_reason in (
    'manual', 'kill_switch', 'host_cli', 'host_rejected', 'superseded'
  )),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  constraint permission_yolo_leases_target_check check (
    (scope = 'thread' and bot_id is not null and thread_id is not null and profile is not null and session_key is not null)
    or (scope = 'bot' and bot_id is not null and thread_id is null and profile is not null and session_key is null)
    or (scope = 'runtime' and bot_id is null and thread_id is null and profile is null and session_key is null)
  ),
  constraint permission_yolo_leases_window_check check (
    not_before >= issued_at and expires_at > not_before and expires_at <= issued_at + interval '24 hours'
  ),
  constraint permission_yolo_leases_revoke_check check (
    (revoked_at is null) = (revoke_reason is null) and (revoked_at is not null or revoked_by_user_id is null)
  ),
  constraint permission_yolo_leases_host_state_at_check check (host_state <> 'pending' or host_state_at is null)
);

-- Un bail non révoqué par cible : un nouvel octroi remplace l'ancien
-- (`superseded`), expiré ou non. Les cibles absentes valent l'uuid nul.
create unique index permission_yolo_leases_one_per_target_idx on permission_yolo_leases (
  runtime_id, scope,
  coalesce(bot_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(thread_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where revoked_at is null;
create index permission_yolo_leases_live_idx on permission_yolo_leases (organization_id, expires_at)
  where revoked_at is null;
create index permission_yolo_leases_org_idx on permission_yolo_leases (organization_id, created_at);

comment on table permission_yolo_leases is
  'Mode YOLO : baux signés (Ed25519, ohb-yolo-lease/v1) qui laissent l''hôte auto-approuver un thread, un bot ou un runtime, 24 h au plus. Écrits seulement par grant_permission_yolo_lease et revoke_permission_yolo_leases (owner ou admin) ; l''état hôte est mis à jour par le lien (PR 4).';
comment on column permission_yolo_leases.payload is
  'La charge utile canonique v1 signée, telle que poussée à l''hôte ; les colonnes de portée et de fenêtre en sont dérivées.';

-- Ce qui a été signé ne change plus, et un bail révoqué le reste : même le
-- propriétaire des tables passe par ce garde.
create function permission_yolo_leases_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.id, new.organization_id, new.runtime_id, new.scope, new.bot_id, new.thread_id, new.profile,
      new.session_key, new.granted_by_user_id, new.issued_at, new.not_before, new.expires_at, new.key_id,
      new.signature, new.payload, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.runtime_id, old.scope, old.bot_id, old.thread_id, old.profile,
      old.session_key, old.granted_by_user_id, old.issued_at, old.not_before, old.expires_at, old.key_id,
      old.signature, old.payload, old.created_at) then
    raise exception 'a signed YOLO lease is immutable' using errcode = '42501';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by_user_id, new.revoke_reason)
     is distinct from (old.revoked_at, old.revoked_by_user_id, old.revoke_reason) then
    raise exception 'a revoked YOLO lease stays revoked' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger permission_yolo_leases_guard before update on permission_yolo_leases
  for each row execute function permission_yolo_leases_guard();

alter table permission_yolo_leases enable row level security;
alter table permission_yolo_leases force row level security;
-- API : l'organisation courante ; le rôle est vérifié par la route et par
-- les fonctions d'écriture. Jamais d'INSERT direct.
create policy permission_yolo_leases_tenant on permission_yolo_leases to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- Worker : sous le tenant du run ou de la passe (la porte lie la lecture au
-- run), jamais en using (true).
create policy permission_yolo_leases_worker on permission_yolo_leases to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- Les seules colonnes modifiables hors des fonctions : la livraison et l'état
-- que l'hôte rapporte (PR 4). La révocation passe par la fonction.
grant select on permission_yolo_leases to ohb_api;
grant update (delivered_at, host_state, host_state_reason, host_state_at) on permission_yolo_leases to ohb_api;
grant select on permission_yolo_leases to ohb_worker;
grant update (delivered_at, host_state, host_state_reason, host_state_at) on permission_yolo_leases to ohb_worker;

-- L'audit local des auto-approbations, une chaîne par runtime (`write_seq`
-- de l'hôte) ; l'idempotence d'un envoi rejoué tient à (runtime_id,
-- write_seq). Pas de FK vers runtimes ni vers le bail : l'audit survit à
-- l'un comme à l'autre.
create table permission_yolo_audit (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  lease_id uuid not null,
  write_seq bigint not null check (write_seq >= 1),
  event_id uuid not null,
  occurred_at timestamptz not null,
  profile text not null check (char_length(profile) between 1 and 128),
  gate_kind text not null check (gate_kind ~ '^[a-z_]{1,64}$'),
  tool_key text check (tool_key is null or char_length(tool_key) between 1 and 256),
  args_hash text not null check (args_hash ~ '^[0-9a-f]{64}$'),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  unique (runtime_id, write_seq)
);

create index permission_yolo_audit_org_idx on permission_yolo_audit (organization_id, id);
create index permission_yolo_audit_lease_idx on permission_yolo_audit (organization_id, lease_id, id);

comment on table permission_yolo_audit is
  'Mode YOLO : entrées « auto-approuvé (YOLO) » de l''audit local scellé de l''hôte, remontées au retour du lien (PR 4). Hash des arguments seulement. Append-only.';

create function permission_yolo_audit_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'permission_yolo_audit is append-only' using errcode = '42501';
end;
$$;

create trigger permission_yolo_audit_no_update before update on permission_yolo_audit
  for each row execute function permission_yolo_audit_append_only();

alter table permission_yolo_audit enable row level security;
alter table permission_yolo_audit force row level security;
create policy permission_yolo_audit_tenant on permission_yolo_audit to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy permission_yolo_audit_worker on permission_yolo_audit for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- INSERT : l'ingestion de `yolo.audit` par le lien (PR 4), dans l'API.
grant select, insert on permission_yolo_audit to ohb_api;
grant select on permission_yolo_audit to ohb_worker;

create table permission_yolo_consents (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  solo_default boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

comment on table permission_yolo_consents is
  'Mode YOLO : la confirmation donnée la première fois par un utilisateur, et son YOLO par défaut en mode solo (PR 7). Le kill switch remet solo_default à false.';

alter table permission_yolo_consents enable row level security;
alter table permission_yolo_consents force row level security;
create policy permission_yolo_consents_tenant on permission_yolo_consents to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy permission_yolo_consents_worker on permission_yolo_consents for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert on permission_yolo_consents to ohb_api;
grant update (acknowledged_at, solo_default, updated_at) on permission_yolo_consents to ohb_api;
grant select on permission_yolo_consents to ohb_worker;

-- Une décision YOLO de la porte du cloud (étape du domaine, PR 1).
alter table approval_requests drop constraint approval_requests_decision_stage_check;
alter table approval_requests
  add constraint approval_requests_decision_stage_check
    check (decision_stage is null or decision_stage in
      ('forbidden', 'yolo', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human', 'unattended'));

-- Le seul chemin d'octroi. L'appelant (l'API) a construit et signé la charge
-- utile ; la fonction en dérive chaque colonne et revérifie, sous le verrou
-- de l'organisation que la porte tient `for share` :
--   * le tenant et un membre owner ou admin vivant (une agence n'est pas
--     membre du client, D-5) ; `grantedBy` est cet utilisateur ;
--   * la politique : un plafond sous `bypass` ou une revue imposée refusent
--     (jamais une rétrogradation silencieuse), et la deny-list de commandes
--     signée est celle de l'organisation à cet instant ;
--   * l'hôte : il annonce `yolo_lease` (et `yolo_thread_scope` pour un
--     thread) ;
--   * la cible : un bot vivant de l'organisation, son profil, et la session
--     Hermes du thread ;
--   * la première confirmation, enregistrée ici quand elle est donnée ;
--   * un `issuedAt` à cinq minutes au plus de l'horloge de la base.
-- Elle remplace le bail précédent de la même cible et relève la révision
-- des bots couverts : une décision prise avant est refaite au relais.
create or replace function grant_permission_yolo_lease(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_bot_id uuid,
  p_thread_id uuid,
  p_key_id text,
  p_signature text,
  p_payload jsonb,
  p_acknowledged boolean
)
returns table (status text, superseded uuid[])
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant uuid;
  organization_found boolean;
  lease_scope text;
  lease_id uuid;
  lease_runtime uuid;
  lease_profile text;
  lease_session text;
  lease_issued timestamptz;
  ceiling text;
  enforced boolean;
  blocklist text[];
  features text[];
  bot_profile text;
  thread_session text;
  replaced uuid[];
begin
  begin
    tenant := nullif(current_setting('app.organization_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      tenant := null;
  end;
  if tenant is null or tenant is distinct from p_organization_id then
    raise exception 'organization context mismatch' using errcode = '42501', hint = 'TENANT_MISMATCH';
  end if;
  select true into organization_found
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if organization_found is null then
    raise exception 'organization not found' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload ->> 'v' is distinct from '1'
     or p_payload ->> 'organizationId' is distinct from p_organization_id::text
     or p_payload ->> 'grantedBy' is distinct from p_actor_user_id::text
     or jsonb_typeof(p_payload -> 'issuedAt') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'notBefore') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'expiresAt') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'deny' -> 'commands') is distinct from 'array'
     or p_acknowledged is null then
    raise exception 'malformed YOLO lease' using errcode = '22023';
  end if;
  lease_id := (p_payload ->> 'leaseId')::uuid;
  lease_runtime := (p_payload ->> 'runtimeId')::uuid;
  lease_scope := p_payload ->> 'scope';
  lease_profile := p_payload ->> 'profile';
  lease_session := p_payload ->> 'sessionKey';
  lease_issued := to_timestamp((p_payload ->> 'issuedAt')::bigint);
  if abs(extract(epoch from now()) - (p_payload ->> 'issuedAt')::bigint) > 300 then
    raise exception 'YOLO lease issued at another time' using errcode = '22023';
  end if;

  select p.max_mode, p.enforce_review, p.command_blocklist into ceiling, enforced, blocklist
    from public.organization_permission_policies p
   where p.organization_id = p_organization_id;
  if ceiling is not null and ceiling <> 'bypass' then
    return query select 'blocked_ceiling'::text, '{}'::uuid[];
    return;
  end if;
  if enforced then
    return query select 'blocked_enforce_review'::text, '{}'::uuid[];
    return;
  end if;
  if (p_payload -> 'deny' -> 'commands') is distinct from to_jsonb(coalesce(blocklist, '{}'::text[])) then
    return query select 'policy_changed'::text, '{}'::uuid[];
    return;
  end if;

  select r.link_features into features
    from public.runtimes r
   where r.organization_id = p_organization_id and r.id = lease_runtime and r.revoked_at is null;
  if features is null then
    return query select 'runtime_not_found'::text, '{}'::uuid[];
    return;
  end if;
  if not ('yolo_lease' = any(features)) then
    return query select 'host_unsupported'::text, '{}'::uuid[];
    return;
  end if;
  if lease_scope = 'thread' and not ('yolo_thread_scope' = any(features)) then
    return query select 'host_unsupported_thread'::text, '{}'::uuid[];
    return;
  end if;

  if lease_scope in ('bot', 'thread') then
    select b.hermes_profile into bot_profile
      from public.bots b
     where b.organization_id = p_organization_id and b.id = p_bot_id and b.archived_at is null;
    if not found then
      return query select 'target_not_found'::text, '{}'::uuid[];
      return;
    end if;
    if bot_profile is null then
      return query select 'bot_profile_missing'::text, '{}'::uuid[];
      return;
    end if;
    if lease_profile is distinct from bot_profile then
      return query select 'target_changed'::text, '{}'::uuid[];
      return;
    end if;
  end if;
  if lease_scope = 'thread' then
    select encode(sha256(convert_to(t.hermes_session_id, 'UTF8')), 'hex') into thread_session
      from public.threads t
     where t.organization_id = p_organization_id and t.id = p_thread_id and t.bot_id = p_bot_id;
    if thread_session is null then
      return query select 'target_not_found'::text, '{}'::uuid[];
      return;
    end if;
    if lease_session is distinct from thread_session then
      return query select 'target_changed'::text, '{}'::uuid[];
      return;
    end if;
  end if;

  if not p_acknowledged and not exists (
    select 1 from public.permission_yolo_consents c
     where c.organization_id = p_organization_id and c.user_id = p_actor_user_id
  ) then
    return query select 'ack_required'::text, '{}'::uuid[];
    return;
  end if;
  if p_acknowledged then
    insert into public.permission_yolo_consents (organization_id, user_id)
    values (p_organization_id, p_actor_user_id)
    on conflict (organization_id, user_id) do update set acknowledged_at = now(), updated_at = now();
  end if;

  with previous as (
    update public.permission_yolo_leases l
       set revoked_at = now(), revoked_by_user_id = p_actor_user_id, revoke_reason = 'superseded'
     where l.organization_id = p_organization_id and l.runtime_id = lease_runtime and l.scope = lease_scope
       and l.bot_id is not distinct from (case when lease_scope = 'runtime' then null else p_bot_id end)
       and l.thread_id is not distinct from (case when lease_scope = 'thread' then p_thread_id else null end)
       and l.revoked_at is null
    returning l.id
  )
  select coalesce(array_agg(previous.id), '{}'::uuid[]) into replaced from previous;

  insert into public.permission_yolo_leases (
    id, organization_id, runtime_id, scope, bot_id, thread_id, profile, session_key, granted_by_user_id,
    issued_at, not_before, expires_at, key_id, signature, payload
  ) values (
    lease_id, p_organization_id, lease_runtime, lease_scope,
    case when lease_scope = 'runtime' then null else p_bot_id end,
    case when lease_scope = 'thread' then p_thread_id else null end,
    lease_profile, lease_session, p_actor_user_id,
    lease_issued, to_timestamp((p_payload ->> 'notBefore')::bigint), to_timestamp((p_payload ->> 'expiresAt')::bigint),
    p_key_id, p_signature, p_payload
  );

  update public.bots b set permission_revision = permission_revision + 1
   where b.organization_id = p_organization_id and (lease_scope = 'runtime' or b.id = p_bot_id);
  return query select 'granted'::text, replaced;
end;
$$;

comment on function grant_permission_yolo_lease(uuid, uuid, uuid, uuid, text, text, jsonb, boolean) is
  'Mode YOLO : le seul octroi d''un bail. Exige app.organization_id = p_organization_id et un membre owner ou admin vivant. Répond granted, blocked_ceiling, blocked_enforce_review, policy_changed, runtime_not_found, host_unsupported, host_unsupported_thread, target_not_found, bot_profile_missing, target_changed ou ack_required.';

-- La seule révocation : un bail (`p_lease_id`) ou tous ceux de l'organisation
-- (`null` : « Couper YOLO partout », qui remet aussi le YOLO solo par défaut à
-- false). Owner ou admin. Rend les baux révoqués à l'instant, pour que l'API
-- pousse `yolo.revoke` à leur runtime ; un bail déjà révoqué n'est pas rendu.
create or replace function revoke_permission_yolo_leases(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_lease_id uuid,
  p_reason text
)
returns table (lease_id uuid, runtime_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  tenant uuid;
  organization_found boolean;
begin
  begin
    tenant := nullif(current_setting('app.organization_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      tenant := null;
  end;
  if tenant is null or tenant is distinct from p_organization_id then
    raise exception 'organization context mismatch' using errcode = '42501', hint = 'TENANT_MISMATCH';
  end if;
  select true into organization_found
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if organization_found is null then
    raise exception 'organization not found' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if p_reason is null or p_reason not in ('manual', 'kill_switch')
     or (p_lease_id is null) <> (p_reason = 'kill_switch') then
    raise exception 'unknown YOLO revocation' using errcode = '22023';
  end if;
  if p_lease_id is null then
    update public.permission_yolo_consents c set solo_default = false, updated_at = now()
     where c.organization_id = p_organization_id and c.solo_default;
  end if;
  return query
    with revoked as (
      update public.permission_yolo_leases l
         set revoked_at = now(), revoked_by_user_id = p_actor_user_id, revoke_reason = p_reason
       where l.organization_id = p_organization_id and l.revoked_at is null
         and (p_lease_id is null or l.id = p_lease_id)
      returning l.id, l.runtime_id, l.scope, l.bot_id
    ), bumped as (
      -- Une CTE qui écrit s'exécute toujours, même sans être lue.
      update public.bots b set permission_revision = permission_revision + 1
       where b.organization_id = p_organization_id
         and exists (select 1 from revoked r where r.scope = 'runtime' or r.bot_id = b.id)
    )
    select r.id, r.runtime_id from revoked r;
end;
$$;

comment on function revoke_permission_yolo_leases(uuid, uuid, uuid, text) is
  'Mode YOLO : la seule révocation. Un bail (manual) ou toute l''organisation (p_lease_id null, kill_switch, solo_default remis à false). Exige app.organization_id = p_organization_id et un membre owner ou admin vivant. Rend les baux révoqués à l''instant.';

revoke all on function grant_permission_yolo_lease(uuid, uuid, uuid, uuid, text, text, jsonb, boolean) from public;
grant execute on function grant_permission_yolo_lease(uuid, uuid, uuid, uuid, text, text, jsonb, boolean) to ohb_api;
revoke all on function revoke_permission_yolo_leases(uuid, uuid, uuid, text) from public;
grant execute on function revoke_permission_yolo_leases(uuid, uuid, uuid, text) to ohb_api;
revoke all on function permission_yolo_leases_guard() from public;
revoke all on function permission_yolo_audit_append_only() from public;

insert into schema_migrations(version) values ('0165_permission_yolo_leases')
on conflict (version) do nothing;

commit;
