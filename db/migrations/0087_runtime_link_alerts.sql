-- Un connector coupé devient une alerte, avec un nom et un destinataire.
--
-- Le lien écrivait déjà `runtimes.last_health_status = 'disconnected'` (broker
-- et balayage du worker), mais personne n'en était prévenu : un runtime pouvait
-- rester muet des jours. Le worker ouvre ici une alerte par panne durable, la
-- résout au retour du lien, et dépose l'e-mail `runtime_link_down` à
-- l'utilisateur concerné (celui qui a appairé le runtime) et aux owners et
-- admins de l'organisation.
--
-- Le backoffice lit toutes les organisations par deux fonctions `security
-- definer` gardées sur `app.staff_user_id`, avec le préambule de
-- `staff_audit_log()` (0035) : le staff ne reçoit aucun grant sur la table.
begin;

create table runtime_link_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  runtime_name text not null,
  kind text not null default 'link_down'
    constraint runtime_link_alerts_kind_check check (kind in ('link_down')),
  status text not null default 'open'
    constraint runtime_link_alerts_status_check check (status in ('open', 'resolved')),
  reason text,
  down_since timestamptz not null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  concerned_user_id uuid references users(id) on delete set null,
  notified_at timestamptz,
  notified_recipients integer not null default 0,
  acknowledged_at timestamptz,
  acknowledged_by uuid references staff_users(id) on delete set null,
  constraint runtime_link_alerts_resolution_check
    check ((status = 'resolved') = (resolved_at is not null))
);

-- Une seule alerte ouverte par runtime : le worker rejoue sa passe chaque tick.
create unique index runtime_link_alerts_one_open_idx
  on runtime_link_alerts (runtime_id) where status = 'open';
create index runtime_link_alerts_opened_idx
  on runtime_link_alerts (opened_at desc);

comment on table runtime_link_alerts is
  'Pannes durables du lien connecteur par runtime : ouverture, résolution, utilisateur concerné, e-mail déposé et acquittement staff.';

alter table runtime_link_alerts enable row level security;
alter table runtime_link_alerts force row level security;

create policy runtime_link_alerts_tenant on runtime_link_alerts to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- Le worker ouvre et résout les alertes de toutes les organisations :
-- exception déclarée dans tests/integration/postgres-rls.sh.
create policy runtime_link_alerts_worker on runtime_link_alerts to ohb_worker
  using (true) with check (true);

grant select on runtime_link_alerts to ohb_api;
grant select, insert, update on runtime_link_alerts to ohb_worker;

create or replace function staff_runtime_link_alerts(
  p_status text default 'open',
  p_limit int default 100,
  p_before timestamptz default null
)
returns table (
  id uuid,
  status text,
  kind text,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  runtime_id uuid,
  runtime_name text,
  reason text,
  down_since timestamptz,
  opened_at timestamptz,
  resolved_at timestamptz,
  concerned_user_id uuid,
  concerned_user_email text,
  concerned_user_name text,
  notified_at timestamptz,
  notified_recipients integer,
  acknowledged_at timestamptz,
  acknowledged_by_email text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  staff_id uuid;
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
  if p_status is null or p_status not in ('open', 'resolved', 'all') then
    raise exception 'invalid alert status' using errcode = '22023';
  end if;

  return query
    select a.id, a.status, a.kind, a.organization_id, o.name, o.slug,
           a.runtime_id, a.runtime_name, a.reason, a.down_since, a.opened_at, a.resolved_at,
           a.concerned_user_id, u.email, u.display_name,
           a.notified_at, a.notified_recipients, a.acknowledged_at, su.email
      from public.runtime_link_alerts a
      left join public.organizations o on o.id = a.organization_id
      left join public.users u on u.id = a.concerned_user_id
      left join public.staff_users su on su.id = a.acknowledged_by
     where (p_status = 'all' or a.status = p_status)
       and (p_before is null or a.opened_at < p_before)
     order by a.opened_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

comment on function staff_runtime_link_alerts(text, int, timestamptz) is
  'Alertes de lien connecteur servies au backoffice staff, les plus récentes d''abord. `p_status` : open, resolved ou all. Pagination par curseur `p_before` sur `opened_at`, `p_limit` borné à 500.';

revoke all on function staff_runtime_link_alerts(text, int, timestamptz) from public;
grant execute on function staff_runtime_link_alerts(text, int, timestamptz) to ohb_api;

create or replace function staff_acknowledge_runtime_link_alert(p_alert uuid)
returns table (acknowledged_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  staff_id uuid;
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

  -- Idempotent : le premier acquittement garde sa date et son auteur.
  return query
    update public.runtime_link_alerts a
       set acknowledged_at = coalesce(a.acknowledged_at, now()),
           acknowledged_by = coalesce(a.acknowledged_by, staff_id)
     where a.id = p_alert
     returning a.acknowledged_at;
end;
$$;

comment on function staff_acknowledge_runtime_link_alert(uuid) is
  'Acquitte une alerte de lien connecteur au nom du staff courant. Aucune ligne rendue : alerte inconnue.';

revoke all on function staff_acknowledge_runtime_link_alert(uuid) from public;
grant execute on function staff_acknowledge_runtime_link_alert(uuid) to ohb_api;

-- Jumelle SQL de TRANSACTIONAL_EMAIL_KINDS (contracts/api/src/email-kinds.ts).
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created',
    'staff_password_reset',
    'support_new_conversation',
    'runtime_link_down'
  ));

insert into schema_migrations(version) values ('0087_runtime_link_alerts')
on conflict (version) do nothing;

commit;
