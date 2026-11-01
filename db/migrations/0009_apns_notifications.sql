begin;

-- Pile APNs : enregistrements d'appareils et de Live Activities (tokens
-- chiffrés, jamais renvoyés), outbox de transitions de workflows et fan-out
-- durable par destination. Les triggers sur workflows alimentent l'outbox.

-- Un token APNs est un identifiant de livraison sensible. La valeur brute est
-- chiffrée comme les secrets runtime ; seul son SHA-256 sert aux collisions et
-- n'est jamais renvoyé au client.
create table apns_device_registrations (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  installation_id text not null,
  bundle_id text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  token_nonce text,
  token_tag text,
  token_key_id text,
  last_registered_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, installation_id),
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  check (length(installation_id) between 1 and 128),
  check (length(bundle_id) between 3 and 255),
  check (
    (revoked_at is null and token_ciphertext is not null and token_nonce is not null
      and token_tag is not null and token_key_id is not null)
    or
    (revoked_at is not null and token_ciphertext is null and token_nonce is null
      and token_tag is null and token_key_id is null)
  )
);

-- Un token actif ne peut appartenir qu'à une identité. Le trigger ci-dessous
-- révoque l'ancien rattachement avant que cet index arbitre les courses.
create unique index apns_device_active_token_idx
  on apns_device_registrations (token_hash)
  where revoked_at is null;
create index apns_device_user_active_idx
  on apns_device_registrations (organization_id, user_id, updated_at desc)
  where revoked_at is null;

alter table apns_device_registrations enable row level security;
alter table apns_device_registrations force row level security;
create policy apns_device_user on apns_device_registrations to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
create policy apns_device_worker on apns_device_registrations to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on apns_device_registrations to ohb_api;
grant select, insert, update, delete on apns_device_registrations to ohb_worker;

-- Une réinstallation ou un changement de compte peut conserver le même token
-- Apple. L'ancien rattachement est rendu inutilisable et son secret effacé
-- avant d'activer le nouveau, afin qu'une notification d'un ancien tenant ne
-- puisse jamais partir vers le nouvel utilisateur.
create or replace function revoke_previous_apns_registration()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.revoked_at is null then
    update public.apns_device_registrations
       set revoked_at = now(), token_ciphertext = null, token_nonce = null,
           token_tag = null, token_key_id = null, updated_at = now()
     where token_hash = new.token_hash and id <> new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function revoke_previous_apns_registration() from public;

create trigger apns_device_reassign
before insert or update of token_hash, revoked_at on apns_device_registrations
for each row execute function revoke_previous_apns_registration();

-- L'outbox ne contient aucun texte du fil, sortie du bot ou détail d'erreur :
-- seulement les identifiants de routage et la transition à présenter.
create table apns_notification_outbox (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  user_id uuid not null,
  workflow_id uuid not null,
  thread_id uuid not null,
  notification_sequence bigint not null check (notification_sequence > 0),
  previous_status text not null check (previous_status in (
    'queued', 'running', 'awaiting_approval', 'reconciling',
    'completed', 'failed', 'cancelled', 'expired', 'unknown'
  )),
  next_status text not null check (next_status in (
    'queued', 'running', 'awaiting_approval', 'reconciling',
    'completed', 'failed', 'cancelled', 'expired', 'unknown'
  )),
  activity_operation text not null check (activity_operation in ('update', 'end')),
  present_alert boolean not null,
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, workflow_id, notification_sequence),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade
);

create index apns_notification_claimable_idx
  on apns_notification_outbox (available_at, created_at)
  where status in ('pending', 'sending');

alter table apns_notification_outbox enable row level security;
alter table apns_notification_outbox force row level security;
create policy apns_notification_worker on apns_notification_outbox to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on apns_notification_outbox to ohb_worker;
grant usage, select on sequence apns_notification_outbox_id_seq to ohb_worker;

-- Le compteur vit sur la ligne workflow verrouillée par l'UPDATE. PostgreSQL
-- sérialise donc deux transitions concurrentes avant que l'outbox soit écrite.
create or replace function advance_workflow_notification_sequence()
returns trigger
language plpgsql
as $$
begin
  if old.status is distinct from new.status then
    new.notification_sequence := old.notification_sequence + 1;
  else
    -- Le compteur ne se modifie jamais directement, même par une requête qui
    -- tenterait de l'écrire sans transition de statut.
    new.notification_sequence := old.notification_sequence;
  end if;
  return new;
end;
$$;

create trigger workflows_notification_sequence
before update on workflows
for each row execute function advance_workflow_notification_sequence();

-- Les salons et routines sont des workflows longs par nature : leur suivi ne
-- dépend pas de l'option `autonomy_enabled`, qui contrôle seulement les
-- délégations spontanées d'un DM.
create or replace function enqueue_autonomous_workflow_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not (new.autonomy_enabled or new.kind in ('group', 'routine'))
     or new.initiator_user_id is null
     or old.status is not distinct from new.status then
    return new;
  end if;

  insert into public.apns_notification_outbox (
    organization_id, user_id, workflow_id, thread_id, notification_sequence,
    previous_status, next_status, activity_operation, present_alert, occurred_at
  ) values (
    new.organization_id, new.initiator_user_id, new.id, new.thread_id, new.notification_sequence,
    old.status, new.status,
    case when new.status in ('completed', 'failed', 'cancelled', 'expired', 'unknown') then 'end' else 'update' end,
    new.status in ('awaiting_approval', 'completed', 'failed', 'expired', 'unknown'),
    now()
  ) on conflict (organization_id, workflow_id, notification_sequence) do nothing;
  return new;
end;
$$;
revoke all on function enqueue_autonomous_workflow_notification() from public;

create trigger workflows_apns_notification
after update of status on workflows
for each row execute function enqueue_autonomous_workflow_notification();

-- Le dispatcher ne peut modifier que le bail et le résultat de livraison. Le
-- plan minimal de transition reste immuable, même après retry ou échec APNs.
create or replace function protect_apns_notification_transition()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id <> new.organization_id
     or old.user_id <> new.user_id
     or old.workflow_id <> new.workflow_id
     or old.thread_id <> new.thread_id
     or old.notification_sequence <> new.notification_sequence
     or old.previous_status <> new.previous_status
     or old.next_status <> new.next_status
     or old.activity_operation <> new.activity_operation
     or old.present_alert <> new.present_alert
     or old.occurred_at <> new.occurred_at then
    raise exception 'APNs notification transition fields are immutable';
  end if;
  return new;
end;
$$;

create trigger apns_notification_transition_immutable
before update on apns_notification_outbox
for each row execute function protect_apns_notification_transition();

-- Les tokens Live Activity sont distincts du token APNs de l'application. Ils
-- restent rattachés à une installation active et à un workflow du même
-- tenant, avec une séquence exclusivement avancée par le dispatcher serveur.
-- Le start est local : l'activité doit exister pour que l'app obtienne puis
-- enregistre ce token. L'outbox pilote ensuite update et end en ordre strict
-- à partir de notification_sequence.
create table apns_live_activity_registrations (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  installation_id text not null,
  workflow_id uuid not null,
  activity_id text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text,
  token_nonce text,
  token_tag text,
  token_key_id text,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  status text not null default 'active' check (status in ('active', 'ended')),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, installation_id, workflow_id, activity_id),
  unique (organization_id, id),
  foreign key (organization_id, user_id, installation_id)
    references apns_device_registrations(organization_id, user_id, installation_id) on delete cascade,
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  check (length(activity_id) between 1 and 128),
  check (
    (status = 'active' and ended_at is null and token_ciphertext is not null
      and token_nonce is not null and token_tag is not null and token_key_id is not null)
    or
    (status = 'ended' and ended_at is not null and token_ciphertext is null
      and token_nonce is null and token_tag is null and token_key_id is null)
  )
);

create unique index apns_live_activity_active_token_idx
  on apns_live_activity_registrations (token_hash)
  where status = 'active';
create index apns_live_activity_workflow_active_idx
  on apns_live_activity_registrations (organization_id, workflow_id, updated_at desc)
  where status = 'active';

alter table apns_live_activity_registrations enable row level security;
alter table apns_live_activity_registrations force row level security;
create policy apns_live_activity_user on apns_live_activity_registrations to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );
create policy apns_live_activity_worker on apns_live_activity_registrations to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on apns_live_activity_registrations to ohb_api;
grant select, insert, update, delete on apns_live_activity_registrations to ohb_worker;

create or replace function end_previous_live_activity_token()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'active' then
    update public.apns_live_activity_registrations
       set status = 'ended', ended_at = now(), token_ciphertext = null,
           token_nonce = null, token_tag = null, token_key_id = null, updated_at = now()
     where token_hash = new.token_hash and id <> new.id and status = 'active';
  end if;
  return new;
end;
$$;
revoke all on function end_previous_live_activity_token() from public;

create trigger apns_live_activity_reassign
before insert or update of token_hash, status on apns_live_activity_registrations
for each row execute function end_previous_live_activity_token();

create or replace function protect_live_activity_progress()
returns trigger
language plpgsql
as $$
begin
  if new.last_sequence < old.last_sequence then
    raise exception 'Live Activity sequence cannot move backwards';
  end if;
  if old.status = 'ended' and new.status <> 'ended' then
    raise exception 'An ended Live Activity cannot be reactivated';
  end if;
  return new;
end;
$$;

create trigger apns_live_activity_progress_guard
before update on apns_live_activity_registrations
for each row execute function protect_live_activity_progress();

create or replace function end_live_activities_with_device()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update public.apns_live_activity_registrations
       set status = 'ended', ended_at = now(), token_ciphertext = null,
           token_nonce = null, token_tag = null, token_key_id = null, updated_at = now()
     where organization_id = new.organization_id and user_id = new.user_id
       and installation_id = new.installation_id and status = 'active';
  end if;
  return new;
end;
$$;
revoke all on function end_live_activities_with_device() from public;

create trigger apns_device_end_live_activities
after update of revoked_at on apns_device_registrations
for each row execute function end_live_activities_with_device();

-- Une ligne par destination rend le fan-out durable. Son UUID est aussi
-- l'`apns-id` : il reste stable pendant tous les retries, même après crash du
-- worker. Les secrets restent exclusivement dans les tables d'enregistrement.
create table apns_notification_deliveries (
  id uuid primary key,
  outbox_id bigint not null references apns_notification_outbox(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null,
  workflow_id uuid not null,
  notification_sequence bigint not null check (notification_sequence > 0),
  device_registration_id uuid,
  live_activity_registration_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'invalid')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  last_http_status integer check (last_http_status between 100 and 599),
  last_reason text check (last_reason is null or length(last_reason) <= 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  foreign key (organization_id, device_registration_id)
    references apns_device_registrations(organization_id, id) on delete cascade,
  foreign key (organization_id, live_activity_registration_id)
    references apns_live_activity_registrations(organization_id, id) on delete cascade,
  check ((device_registration_id is not null)::integer
       + (live_activity_registration_id is not null)::integer = 1)
);

create unique index apns_delivery_device_once_idx
  on apns_notification_deliveries (outbox_id, device_registration_id)
  where device_registration_id is not null;
create unique index apns_delivery_live_activity_once_idx
  on apns_notification_deliveries (outbox_id, live_activity_registration_id)
  where live_activity_registration_id is not null;
create index apns_delivery_claimable_idx
  on apns_notification_deliveries (available_at, created_at)
  where status in ('pending', 'sending');

alter table apns_notification_deliveries enable row level security;
alter table apns_notification_deliveries force row level security;
create policy apns_delivery_worker on apns_notification_deliveries to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on apns_notification_deliveries to ohb_worker;

create or replace function protect_apns_delivery_identity()
returns trigger
language plpgsql
as $$
begin
  if old.outbox_id <> new.outbox_id
     or old.organization_id <> new.organization_id
     or old.user_id <> new.user_id
     or old.workflow_id <> new.workflow_id
     or old.notification_sequence <> new.notification_sequence
     or old.device_registration_id is distinct from new.device_registration_id
     or old.live_activity_registration_id is distinct from new.live_activity_registration_id then
    raise exception 'APNs delivery identity fields are immutable';
  end if;
  return new;
end;
$$;

create trigger apns_delivery_identity_immutable
before update on apns_notification_deliveries
for each row execute function protect_apns_delivery_identity();

insert into schema_migrations(version) values ('0009_apns_notifications')
on conflict (version) do nothing;

commit;
