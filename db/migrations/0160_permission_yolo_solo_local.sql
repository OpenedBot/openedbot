-- Mode YOLO (PR 7/8) : le mode solo local. Une organisation à un seul membre,
-- son owner, qui a consenti au YOLO par défaut (`permission_yolo_consents.
-- solo_default`) : le système renouvelle pour son compte un bail de portée
-- runtime de 24 h sur chacun de ses runtimes, tant que les deux conditions
-- tiennent. « Solo local » n'a rien à voir avec le cœur sans plug-ins.
--
--   * permission_yolo_leases.solo_default : le bail vient de ce
--     renouvellement, jamais d'un octroi à la main. Signé comme les autres,
--     et immuable comme eux.
--   * grant_permission_yolo_solo_lease : le seul octroi du système. Il
--     revérifie sous le verrou de l'organisation un seul membre vivant, owner
--     (le `grantedBy` du bail), son consentement, la politique, l'hôte, et des
--     protections `.ssh`, `.env` et trousseau dans la charge signée. Idempotent :
--     tant que le bail runtime vivant dure plus que la marge, `not_due`.
--   * end_permission_yolo_solo_default : la fin du YOLO par défaut, par
--     l'owner ou un admin (`manual`) ou par le système quand l'organisation
--     n'est plus solo (`superseded`) : consentements remis à false et baux
--     solo révoqués.
--   * revoke_permission_yolo_leases_by_host : un `edge-setup yolo off`
--     rapporté (`host_cli`) remet aussi le YOLO par défaut à false et révoque
--     les baux solo du runtime, même émis après le kill : un renouvellement ne
--     contourne jamais un kill.
--   * le genre d'e-mail `yolo_solo_default_ended`.
begin;

alter table permission_yolo_leases
  add column solo_default boolean not null default false,
  add constraint permission_yolo_leases_solo_default_check check (not solo_default or scope = 'runtime');

create index permission_yolo_leases_solo_idx on permission_yolo_leases (organization_id, runtime_id)
  where solo_default and revoked_at is null;

comment on column permission_yolo_leases.solo_default is
  'Mode solo local : bail runtime de 24 h émis par le système pour le compte de l''owner (grant_permission_yolo_solo_lease), jamais par un bot.';

-- Le garde de 0158, avec la nouvelle colonne parmi ce qui ne change plus.
create or replace function permission_yolo_leases_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.id, new.organization_id, new.runtime_id, new.scope, new.bot_id, new.thread_id, new.profile,
      new.session_key, new.granted_by_user_id, new.issued_at, new.not_before, new.expires_at, new.key_id,
      new.signature, new.payload, new.created_at, new.solo_default)
     is distinct from
     (old.id, old.organization_id, old.runtime_id, old.scope, old.bot_id, old.thread_id, old.profile,
      old.session_key, old.granted_by_user_id, old.issued_at, old.not_before, old.expires_at, old.key_id,
      old.signature, old.payload, old.created_at, old.solo_default) then
    raise exception 'a signed YOLO lease is immutable' using errcode = '42501';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by_user_id, new.revoke_reason)
     is distinct from (old.revoked_at, old.revoked_by_user_id, old.revoke_reason) then
    raise exception 'a revoked YOLO lease stays revoked' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Une organisation « solo » : exactement un membre vivant, et c'est cet owner.
create or replace function permission_yolo_is_solo(p_organization_id uuid, p_owner_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (select count(*) from public.memberships m
           where m.organization_id = p_organization_id and m.revoked_at is null) = 1
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_organization_id and m.user_id = p_owner_user_id
                    and m.role = 'owner' and m.revoked_at is null);
$$;

-- Le renouvellement solo. L'appelant (l'API, qui tient la clé) a construit et
-- signé un bail runtime de 24 h pour le compte de l'owner ; la fonction le
-- refuse s'il n'est pas exactement cela. Statuts : granted, not_due,
-- not_solo, consent_off, blocked_ceiling, blocked_enforce_review,
-- policy_changed, runtime_not_found, host_unsupported.
create or replace function grant_permission_yolo_solo_lease(
  p_organization_id uuid,
  p_owner_user_id uuid,
  p_key_id text,
  p_signature text,
  p_payload jsonb,
  p_renew_before_seconds integer
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
  lease_runtime uuid;
  ceiling text;
  enforced boolean;
  blocklist text[];
  features text[];
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
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload ->> 'v' is distinct from '1'
     or p_payload ->> 'organizationId' is distinct from p_organization_id::text
     or p_payload ->> 'grantedBy' is distinct from p_owner_user_id::text
     or p_payload ->> 'scope' is distinct from 'runtime'
     or p_payload -> 'profile' is distinct from 'null'::jsonb
     or p_payload -> 'sessionKey' is distinct from 'null'::jsonb
     or jsonb_typeof(p_payload -> 'issuedAt') is distinct from 'number'
     or p_payload -> 'notBefore' is distinct from p_payload -> 'issuedAt'
     or jsonb_typeof(p_payload -> 'expiresAt') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'deny' -> 'commands') is distinct from 'array'
     or jsonb_typeof(p_payload -> 'protect') is distinct from 'array'
     or p_renew_before_seconds is null or p_renew_before_seconds < 0 then
    raise exception 'malformed solo YOLO lease' using errcode = '22023';
  end if;
  -- Les protections du mode solo local : jamais sans .ssh, .env ni trousseau.
  if not (p_payload -> 'protect' @> '["ssh", "env", "keychain"]'::jsonb) then
    raise exception 'a solo YOLO lease protects .ssh, .env and the keychain' using errcode = '22023';
  end if;
  if abs(extract(epoch from now()) - (p_payload ->> 'issuedAt')::bigint) > 300 then
    raise exception 'YOLO lease issued at another time' using errcode = '22023';
  end if;
  lease_runtime := (p_payload ->> 'runtimeId')::uuid;

  if not permission_yolo_is_solo(p_organization_id, p_owner_user_id) then
    return query select 'not_solo'::text, '{}'::uuid[];
    return;
  end if;
  if not exists (
    select 1 from public.permission_yolo_consents c
     where c.organization_id = p_organization_id and c.user_id = p_owner_user_id and c.solo_default
  ) then
    return query select 'consent_off'::text, '{}'::uuid[];
    return;
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

  -- Idempotent : un bail runtime vivant qui dure encore au-delà de la marge
  -- suffit, qu'il soit solo ou octroyé à la main.
  if exists (
    select 1 from public.permission_yolo_leases l
     where l.organization_id = p_organization_id and l.runtime_id = lease_runtime and l.scope = 'runtime'
       and l.revoked_at is null and l.expires_at > now() + make_interval(secs => p_renew_before_seconds)
  ) then
    return query select 'not_due'::text, '{}'::uuid[];
    return;
  end if;

  with previous as (
    update public.permission_yolo_leases l
       set revoked_at = now(), revoked_by_user_id = null, revoke_reason = 'superseded'
     where l.organization_id = p_organization_id and l.runtime_id = lease_runtime and l.scope = 'runtime'
       and l.revoked_at is null
    returning l.id
  )
  select coalesce(array_agg(previous.id), '{}'::uuid[]) into replaced from previous;

  insert into public.permission_yolo_leases (
    id, organization_id, runtime_id, scope, granted_by_user_id,
    issued_at, not_before, expires_at, key_id, signature, payload, solo_default
  ) values (
    (p_payload ->> 'leaseId')::uuid, p_organization_id, lease_runtime, 'runtime', p_owner_user_id,
    to_timestamp((p_payload ->> 'issuedAt')::bigint), to_timestamp((p_payload ->> 'notBefore')::bigint),
    to_timestamp((p_payload ->> 'expiresAt')::bigint), p_key_id, p_signature, p_payload, true
  );

  update public.bots b set permission_revision = permission_revision + 1
   where b.organization_id = p_organization_id;
  return query select 'granted'::text, replaced;
end;
$$;

comment on function grant_permission_yolo_solo_lease(uuid, uuid, text, text, jsonb, integer) is
  'Mode solo local : le renouvellement d''un bail runtime de 24 h pour le compte de l''owner unique qui a consenti (solo_default). Exige app.organization_id = p_organization_id ; revérifie solo, consentement, politique, hôte et protections sous le verrou de l''organisation ; not_due tant qu''un bail runtime vivant dure plus que la marge.';

-- La fin du YOLO par défaut. `p_actor_user_id` : un owner ou un admin vivant
-- qui le coupe (`manual`) ; null : le système, seulement quand l'organisation
-- n'est plus solo (`superseded`). Rend `ended` si un consentement ou un bail
-- a changé, `unchanged` sinon, `still_solo` si le système n'avait pas à agir.
create or replace function end_permission_yolo_solo_default(
  p_organization_id uuid,
  p_actor_user_id uuid
)
returns table (status text, lease_ids uuid[], runtime_ids uuid[])
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant uuid;
  organization_found boolean;
  sole_owner uuid;
  reset_count integer;
  revoked_leases uuid[];
  revoked_runtimes uuid[];
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
  if p_actor_user_id is null then
    select m.user_id into sole_owner
      from public.memberships m
     where m.organization_id = p_organization_id and m.revoked_at is null and m.role = 'owner'
     limit 1;
    if sole_owner is not null and permission_yolo_is_solo(p_organization_id, sole_owner) then
      return query select 'still_solo'::text, '{}'::uuid[], '{}'::uuid[];
      return;
    end if;
  elsif not exists (
    select 1 from public.memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;

  update public.permission_yolo_consents c set solo_default = false, updated_at = now()
   where c.organization_id = p_organization_id and c.solo_default;
  get diagnostics reset_count = row_count;

  with revoked as (
    update public.permission_yolo_leases l
       set revoked_at = now(), revoked_by_user_id = p_actor_user_id,
           revoke_reason = case when p_actor_user_id is null then 'superseded' else 'manual' end
     where l.organization_id = p_organization_id and l.solo_default and l.revoked_at is null
    returning l.id, l.runtime_id
  )
  select coalesce(array_agg(revoked.id), '{}'::uuid[]), coalesce(array_agg(revoked.runtime_id), '{}'::uuid[])
    into revoked_leases, revoked_runtimes from revoked;

  if cardinality(revoked_leases) > 0 then
    update public.bots b set permission_revision = permission_revision + 1
     where b.organization_id = p_organization_id;
  end if;
  return query select
    (case when reset_count > 0 or cardinality(revoked_leases) > 0 then 'ended' else 'unchanged' end)::text,
    revoked_leases, revoked_runtimes;
end;
$$;

comment on function end_permission_yolo_solo_default(uuid, uuid) is
  'Mode solo local : coupe le YOLO par défaut (consentements solo_default à false, baux solo révoqués). p_actor_user_id : owner ou admin (manual) ; null : le système, seulement quand l''organisation n''a plus exactement un membre owner (superseded).';

-- La révocation venue de l'hôte (0159), où `host_cli` emporte aussi le mode
-- solo local : consentements remis à false et baux solo du runtime révoqués,
-- même émis après `killedAt` (renouvelés pendant que l'hôte était coupé).
create or replace function revoke_permission_yolo_leases_by_host(
  p_organization_id uuid,
  p_runtime_id uuid,
  p_token_hash text,
  p_lease_ids uuid[],
  p_issued_until timestamptz,
  p_reason text
)
returns table (lease_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  tenant uuid;
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
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from public.runtimes r
     where r.organization_id = p_organization_id and r.id = p_runtime_id and r.revoked_at is null
       and (r.link_token_hash = p_token_hash
         or (r.link_token_previous_hash = p_token_hash and r.link_token_previous_expires_at > now()))
  ) then
    raise exception 'runtime link required' using errcode = '42501', hint = 'RUNTIME_LINK_REQUIRED';
  end if;
  if p_reason is null
     or not ((p_reason = 'host_cli' and p_issued_until is not null and p_lease_ids is null)
          or (p_reason = 'host_rejected' and p_issued_until is null and p_lease_ids is not null)) then
    raise exception 'unknown host YOLO revocation' using errcode = '22023';
  end if;
  if p_reason = 'host_cli' then
    update public.permission_yolo_consents c set solo_default = false, updated_at = now()
     where c.organization_id = p_organization_id and c.solo_default;
  end if;
  return query
    with revoked as (
      update public.permission_yolo_leases l
         set revoked_at = now(), revoke_reason = p_reason
       where l.organization_id = p_organization_id and l.runtime_id = p_runtime_id and l.revoked_at is null
         and (p_lease_ids is null or l.id = any(p_lease_ids))
         and (p_issued_until is null or l.issued_at <= p_issued_until or (p_reason = 'host_cli' and l.solo_default))
      returning l.id, l.scope, l.bot_id
    ), bumped as (
      update public.bots b set permission_revision = permission_revision + 1
       where b.organization_id = p_organization_id
         and exists (select 1 from revoked r where r.scope = 'runtime' or r.bot_id = b.id)
    )
    select r.id from revoked r;
end;
$$;

comment on function revoke_permission_yolo_leases_by_host(uuid, uuid, text, uuid[], timestamptz, text) is
  'Mode YOLO : la révocation qu''un hôte provoque (host_cli : yolo off, baux émis au plus tard à p_issued_until et baux solo du runtime, YOLO par défaut remis à false ; host_rejected : baux nommés refusés). Exige app.organization_id = p_organization_id et le hash du jeton de lien courant (ou précédent en grâce) de ce runtime ; ne touche que ses baux.';

revoke all on function permission_yolo_is_solo(uuid, uuid) from public;
grant execute on function permission_yolo_is_solo(uuid, uuid) to ohb_api;
revoke all on function grant_permission_yolo_solo_lease(uuid, uuid, text, text, jsonb, integer) from public;
grant execute on function grant_permission_yolo_solo_lease(uuid, uuid, text, text, jsonb, integer) to ohb_api;
revoke all on function end_permission_yolo_solo_default(uuid, uuid) from public;
grant execute on function end_permission_yolo_solo_default(uuid, uuid) to ohb_api;
revoke all on function revoke_permission_yolo_leases_by_host(uuid, uuid, text, uuid[], timestamptz, text) from public;
grant execute on function revoke_permission_yolo_leases_by_host(uuid, uuid, text, uuid[], timestamptz, text) to ohb_api;

-- SQL twin of TRANSACTIONAL_EMAIL_KINDS (contracts/api/src/notifications/email-kinds.ts).
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'organization_member_invitation',
  'waitlist_confirmation',
  'waitlist_access_granted',
  'waitlist_access_tier_changed',
  'waitlist_access_revoked',
  'staff_account_created',
  'staff_password_reset',
  'staff_login_code',
  'email_login_code',
  'provider_quota_reached',
  'account_purge_completed',
  'account_closure_notice',
  'support_new_conversation',
  'runtime_link_down',
  'runtime_link_restored',
  'runtime_connector_outdated',
  'yolo_audit_quarantined',
  'yolo_solo_default_ended'
));

insert into schema_migrations(version) values ('0160_permission_yolo_solo_local')
on conflict (version) do nothing;

commit;
