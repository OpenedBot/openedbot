-- DEV-OPE2-7 : être prévenu ailleurs que par e-mail quand un runtime est KO.
--
-- Le 31-10-2026, le connecteur du runtime de dev est resté arrêté dix heures :
-- 0087 a bien ouvert l'alerte et déposé l'e-mail `runtime_link_down`, que
-- personne n'a lu. Une organisation déclare ici des canaux d'alerte (Discord
-- d'abord, Telegram ensuite) ; chaque alerte de lien ouverte puis résolue y
-- dépose une livraison, envoyée par le worker comme les livraisons APNs (0108).
--
-- L'URL d'un webhook Discord EST son secret : qui la tient poste dans le
-- salon. Elle est chiffrée comme les secrets runtime (AES-256-GCM, trousseau
-- RUNTIME_TOKEN_ENCRYPTION_KEY) et jamais rendue ; l'API ne sert qu'un aperçu
-- (`target_hint`) et `target_hash` arbitre les doublons.
begin;

create table alert_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('discord')),
  label text not null check (length(label) between 1 and 80),
  target_hint text not null check (length(target_hint) between 1 and 200),
  target_hash text not null check (target_hash ~ '^[0-9a-f]{64}$'),
  secret_ciphertext text not null,
  secret_nonce text not null,
  secret_tag text not null,
  secret_key_id text not null,
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  last_delivered_at timestamptz,
  last_failure_at timestamptz,
  last_failure_status integer check (last_failure_status is null or last_failure_status between 100 and 599),
  last_failure_reason text check (last_failure_reason is null or last_failure_reason in (
    'webhook_revoked', 'rejected', 'rate_limited', 'unreachable', 'decryption_failed'
  )),
  last_test_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, target_hash),
  check ((last_failure_at is null) = (last_failure_reason is null))
);

create index alert_channels_org_idx on alert_channels (organization_id, created_at);

comment on table alert_channels is
  'Canaux d''alerte d''une organisation (Discord) : URL de webhook chiffrée, jamais rendue ; aperçu et hash pour les doublons. Le worker y relit le secret sous le tenant de la livraison.';

alter table alert_channels enable row level security;
alter table alert_channels force row level security;

-- API : l'organisation courante ; le rôle (owner, admin) est vérifié par la route.
create policy alert_channels_tenant on alert_channels to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- Worker : sous le tenant de la livraison seulement, jamais en using (true) :
-- la table porte un secret chiffré (même règle qu'apns_devices, 0108).
create policy alert_channels_worker on alert_channels to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on alert_channels to ohb_api;
grant select, update on alert_channels to ohb_worker;

-- Une livraison par (canal, alerte, événement) : la clé unique est
-- l'idempotence d'une passe d'alertes rejouée. Ni secret ni texte libre :
-- la charge utile est celle de l'e-mail (nom, raison, heures, lien).
create table alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_id uuid not null,
  alert_id uuid not null references runtime_link_alerts(id) on delete cascade,
  event text not null check (event in ('runtime_link_down', 'runtime_link_restored')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in (
    'pending', 'sending', 'sent', 'failed', 'cancelled'
  )),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_http_status integer check (last_http_status is null or last_http_status between 100 and 599),
  last_reason text check (last_reason is null or last_reason ~ '^[a-z_]{1,64}$'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, alert_id, event),
  foreign key (organization_id, channel_id)
    references alert_channels(organization_id, id) on delete cascade
);

create index alert_deliveries_claimable_idx
  on alert_deliveries (available_at, created_at)
  where status in ('pending', 'sending');
create index alert_deliveries_alert_idx on alert_deliveries (alert_id);

comment on table alert_deliveries is
  'Livraisons des alertes de lien vers les canaux (Discord) : une par (canal, alerte, événement). Retente 429/5xx avec recul borné, puis failed ; 401/403/404 désactivent le canal.';

alter table alert_deliveries enable row level security;
alter table alert_deliveries force row level security;
-- File de réclamation du worker, comme apns_deliveries : elle traverse les
-- organisations et ne porte aucun secret. Le webhook se relit sous le tenant
-- de la ligne. L'API n'y a aucun droit : la suppression d'un canal cascade.
create policy alert_deliveries_worker on alert_deliveries to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on alert_deliveries to ohb_worker;

insert into schema_migrations(version) values ('0157_alert_channels')
on conflict (version) do nothing;

commit;
