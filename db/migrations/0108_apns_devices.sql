begin;

-- DEV-308 (decision DEV-309) : APNs revient comme SECOND transport de
-- l outbox Web Push (0039), pas comme la pile de 0009 (retiree par 0012).
-- Aucune Live Activity, aucune outbox APNs propre : `push_outbox` reste la
-- seule source des transitions notifiables. Le worker ajoute une livraison
-- par appareil APNs actif en plus des abonnements Web Push.
--
-- Un token APNs est un identifiant de livraison sensible. Sa valeur brute est
-- chiffree comme les secrets runtime (AES-256-GCM, trousseau
-- RUNTIME_TOKEN_ENCRYPTION_KEY) ; seul son SHA-256 sert aux collisions. Ni
-- l un ni l autre ne sont jamais rendus au client.

create table apns_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
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
  last_sent_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in (
    'token_moved', 'unregistered', 'bad_device_token', 'device_token_not_for_topic'
  )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, installation_id),
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  check (installation_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  check (bundle_id ~ '^[A-Za-z0-9.-]{3,255}$'),
  check ((revoked_at is null) = (revoked_reason is null)),
  check (
    (revoked_at is null and token_ciphertext is not null and token_nonce is not null
      and token_tag is not null and token_key_id is not null)
    or
    (revoked_at is not null and token_ciphertext is null and token_nonce is null
      and token_tag is null and token_key_id is null)
  )
);

-- Un token actif n appartient qu a un seul rattachement, toutes
-- organisations confondues. Le trigger ci-dessous revoque l ancien avant que
-- cet index arbitre une course.
create unique index apns_devices_active_token_idx
  on apns_devices (token_hash)
  where revoked_at is null;
create index apns_devices_org_active_idx
  on apns_devices (organization_id, created_at)
  where revoked_at is null;

comment on table apns_devices is
  'Appareils iOS (APNs) par membre et installation. Token chiffre, SHA-256 pour les collisions, jamais rendu. Revoque (secret efface) sur collision, 410 ou BadDeviceToken ; supprime au logout natif, au DELETE et au depart du membre.';

alter table apns_devices enable row level security;
alter table apns_devices force row level security;

-- API : le membre ne voit que SES appareils dans l organisation courante,
-- par la meme porte que push_subscriptions (0039).
create policy apns_devices_owner on apns_devices to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  );
-- Worker : sous le tenant de la livraison seulement (withTenant), jamais en
-- using (true) : la table porte un secret chiffre.
create policy apns_devices_worker on apns_devices to openedbot_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on apns_devices to openedbot_api;
grant select, update on apns_devices to openedbot_worker;

-- Une reinstallation ou un changement de compte peut garder le meme token
-- Apple. L ancien rattachement est rendu inutilisable et son secret efface
-- avant d activer le nouveau : une notification de l ancien tenant ne part
-- jamais vers le nouvel utilisateur. SECURITY DEFINER : la ligne a revoquer
-- appartient a un autre membre, invisible sous la RLS de l appelant.
create or replace function revoke_moved_apns_token()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.revoked_at is null then
    update public.apns_devices
       set revoked_at = now(), revoked_reason = 'token_moved',
           token_ciphertext = null, token_nonce = null, token_tag = null,
           token_key_id = null, updated_at = now()
     where token_hash = new.token_hash and id <> new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function revoke_moved_apns_token() from public;

create trigger apns_devices_token_moved
before insert or update of token_hash, revoked_at on apns_devices
for each row execute function revoke_moved_apns_token();

-- Depart d un membre : la membership est revoquee (revoked_at), pas
-- supprimee, donc la FK ne cascade pas. Ce trigger est la cascade. Il vit en
-- base plutot que dans removeMember parce que la policy openedbot_api ne laisse
-- voir que les appareils de l utilisateur authentifie (l acteur, pas le
-- membre retire) : un DELETE applicatif y serait un no-op silencieux.
create or replace function drop_apns_devices_of_revoked_member()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.apns_devices
     where organization_id = new.organization_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function drop_apns_devices_of_revoked_member() from public;

create trigger memberships_drop_apns_devices
after update of revoked_at on memberships
for each row execute function drop_apns_devices_of_revoked_member();

-- Une livraison par (ligne d outbox, appareil) : la cle unique est
-- l idempotence du fan-out. Son UUID est aussi l `apns-id`, stable a travers
-- les essais. Aucun secret ni texte : statut, essais, code HTTP et raison
-- APNs (un mot, jamais un corps).
create table apns_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  outbox_id uuid not null,
  device_id uuid not null,
  status text not null default 'pending' check (status in (
    'pending', 'sending', 'sent', 'failed', 'revoked'
  )),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_http_status integer check (last_http_status is null or last_http_status between 100 and 599),
  last_reason text check (last_reason is null or last_reason ~ '^[A-Za-z]{1,64}$'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outbox_id, device_id),
  unique (organization_id, id),
  foreign key (organization_id, outbox_id)
    references push_outbox(organization_id, id) on delete cascade,
  foreign key (organization_id, device_id)
    references apns_devices(organization_id, id) on delete cascade
);

create index apns_deliveries_claimable_idx
  on apns_deliveries (available_at, created_at)
  where status in ('pending', 'sending');
create index apns_deliveries_device_idx
  on apns_deliveries (organization_id, device_id);

comment on table apns_deliveries is
  'Fan-out APNs de push_outbox : une livraison par (outbox, appareil), apns-id = id. Retente 429/5xx avec backoff borne, puis failed. Aucun token, aucun texte de fil.';

alter table apns_deliveries enable row level security;
alter table apns_deliveries force row level security;
-- File de reclamation du worker, comme push_deliveries : elle traverse les
-- organisations et ne porte aucun secret. Le token se relit sous le tenant
-- de la ligne.
create policy apns_deliveries_worker on apns_deliveries to openedbot_worker
  using (true) with check (true);
grant select, insert, update, delete on apns_deliveries to openedbot_worker;

insert into schema_migrations(version) values ('0108_apns_devices')
on conflict (version) do nothing;

commit;
