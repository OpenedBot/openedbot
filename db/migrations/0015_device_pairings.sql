begin;

-- Appairage d'un appareil : ouvrir la PWA sur un téléphone en étant déjà
-- connecté, sans retaper un mot de passe au pouce sur un petit clavier.
--
-- Le poste déjà authentifié crée l'appairage et affiche un QR. Le téléphone le
-- scanne et échange le secret contre une VRAIE session web : mêmes cookies,
-- même TTL, même révocation que si l'utilisateur s'était connecté à la main.
--
-- Ce jeton donne un accès : quiconque voit l'écran pendant sa validité peut
-- s'en servir. C'est le modèle assumé (l'écran d'un poste déverrouillé vaut
-- autorisation), borné par trois garde-fous inscrits ici plutôt que dans le
-- code : durée de vie courte, usage unique, et traçabilité de l'échange.
create table device_pairings (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  -- Jamais le secret : son SHA-256, comme les jetons de session.
  secret_hash text not null unique,
  -- Affiché des deux côtés pour que l'opérateur voie QUEL appairage aboutit
  -- quand il en a ouvert plusieurs.
  verification_code text not null,
  -- Renseignés à l'échange : de quoi reconnaître un appareil inattendu et
  -- révoquer sa session.
  redeemed_at timestamptz,
  redeemed_ip inet,
  redeemed_user_agent text,
  -- La session créée par l'échange, pour la révoquer avec l'appairage.
  session_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- L'appairage appartient à un membre, pas seulement à un utilisateur : un
  -- compte qui quitte l'organisation ne laisse pas derrière lui un jeton
  -- capable d'ouvrir une session dans ce tenant.
  foreign key (organization_id, user_id) references memberships(organization_id, user_id) on delete cascade
);

create index device_pairings_expiry on device_pairings (expires_at);

alter table device_pairings enable row level security;
alter table device_pairings force row level security;

-- Deux portes, comme pour les enrôlements de runtime :
--   - l'organisation de la session, pour le poste qui crée et surveille ;
--   - le hash du secret présenté, pour le téléphone qui n'a pas encore de
--     session, c'est justement ce qu'il vient chercher.
create policy device_pairings_credential on device_pairings to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

create policy device_pairings_worker on device_pairings to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on device_pairings to ohb_api;
grant select, delete on device_pairings to ohb_worker;

insert into schema_migrations(version) values ('0015_device_pairings')
on conflict (version) do nothing;

commit;
