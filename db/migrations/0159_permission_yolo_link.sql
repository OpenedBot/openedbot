-- Mode YOLO (PR 4/8) : ce que le lien écrit quand l'hôte parle de ses baux.
--
--   * permission_yolo_audit_quarantine : une tranche `yolo.audit` dont la
--     chaîne ne se vérifie pas (hash recalculé faux, maillon qui ne suit pas
--     le dernier reçu, trou de séquence, entrée déjà reçue sous un autre hash,
--     bail inconnu de ce runtime). Elle n'entre pas dans `permission_yolo_audit`,
--     mais elle n'est jamais jetée en silence : conservée ici telle que reçue
--     (métadonnées et hash seulement, jamais d'arguments), journalisée et
--     signalée par e-mail aux owners et admins. Append-only.
--   * revoke_permission_yolo_leases_by_host : la révocation que l'HÔTE
--     provoque (`edge-setup yolo off`, rapporté par `yolo.state.killedAt`, ou
--     un bail que l'hôte a refusé). Sans acteur humain, elle est réservée au
--     lien d'un runtime : le hash de son jeton est revérifié ici, comme la porte
--     `runtimes_link_credential`, et elle ne touche que les baux de ce runtime.
--     L'API n'a toujours aucun droit d'écriture sur les colonnes de révocation.
--   * le genre d'e-mail `yolo_audit_quarantined`.
--
-- Le lien écrit sous `app.organization_id` (l'identité liée la connaît),
-- comme `runtime_link_diagnostics` : aucune politique nouvelle sur le hash de
-- session n'est nécessaire.
begin;

create table permission_yolo_audit_quarantine (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  from_seq bigint not null check (from_seq >= 1),
  to_seq bigint not null,
  tail text not null check (tail ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in (
    'hash_mismatch', 'prev_mismatch', 'seq_gap', 'conflict', 'unknown_lease'
  )),
  -- La première entrée fautive (sa séquence), pour l'enquête.
  broken_seq bigint not null,
  entries jsonb not null check (
    jsonb_typeof(entries) = 'array' and jsonb_array_length(entries) between 1 and 128
  ),
  received_at timestamptz not null default now(),
  check (to_seq >= from_seq and broken_seq between from_seq and to_seq)
);

create index permission_yolo_audit_quarantine_runtime_idx
  on permission_yolo_audit_quarantine (organization_id, runtime_id, to_seq desc);

comment on table permission_yolo_audit_quarantine is
  'Mode YOLO : tranches yolo.audit dont la chaîne ne se vérifie pas, gardées telles que reçues (hash seulement) au lieu d''être rejetées en silence. Append-only.';

create function permission_yolo_audit_quarantine_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'permission_yolo_audit_quarantine is append-only' using errcode = '42501';
end;
$$;

create trigger permission_yolo_audit_quarantine_no_update before update on permission_yolo_audit_quarantine
  for each row execute function permission_yolo_audit_quarantine_append_only();

alter table permission_yolo_audit_quarantine enable row level security;
alter table permission_yolo_audit_quarantine force row level security;
create policy permission_yolo_audit_quarantine_tenant on permission_yolo_audit_quarantine to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy permission_yolo_audit_quarantine_worker on permission_yolo_audit_quarantine for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert on permission_yolo_audit_quarantine to ohb_api;
grant select on permission_yolo_audit_quarantine to ohb_worker;

-- La révocation venue de l'hôte. `host_cli` : tout bail du runtime émis au
-- plus tard à `p_issued_until` (le `killedAt` de l'hôte : un bail émis après
-- reste valable pour lui). `host_rejected` : les baux nommés que l'hôte a
-- refusés. Rend les baux révoqués à l'instant ; un bail déjà révoqué n'est
-- pas rendu (rejouer la même trame ne change rien).
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
  return query
    with revoked as (
      update public.permission_yolo_leases l
         set revoked_at = now(), revoke_reason = p_reason
       where l.organization_id = p_organization_id and l.runtime_id = p_runtime_id and l.revoked_at is null
         and (p_lease_ids is null or l.id = any(p_lease_ids))
         and (p_issued_until is null or l.issued_at <= p_issued_until)
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
  'Mode YOLO : la révocation qu''un hôte provoque (host_cli : yolo off, baux émis au plus tard à p_issued_until ; host_rejected : baux nommés refusés). Exige app.organization_id = p_organization_id et le hash du jeton de lien courant (ou précédent en grâce) de ce runtime ; ne touche que ses baux.';

revoke all on function revoke_permission_yolo_leases_by_host(uuid, uuid, text, uuid[], timestamptz, text) from public;
grant execute on function revoke_permission_yolo_leases_by_host(uuid, uuid, text, uuid[], timestamptz, text) to ohb_api;
revoke all on function permission_yolo_audit_quarantine_append_only() from public;

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
  'yolo_audit_quarantined'
));

insert into schema_migrations(version) values ('0159_permission_yolo_link')
on conflict (version) do nothing;

commit;
