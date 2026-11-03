begin;

-- Appairage d'un runtime Hermes sans transporter son bearer à la main.
--
-- Le chemin manuel : ouvrir une session SSH privilégiée, lire API_SERVER_KEY
-- dans /srv/hermes/data/runtime.env, recopier le secret jusqu'au navigateur,
-- fait passer le bearer par un presse-papiers, un scrollback de terminal et
-- souvent une capture d'écran. Chaque étape est une occasion de fuite.
--
-- Ici le runtime ouvre un enrôlement, affiche un QR qui ne contient QU'UN
-- secret jetable, l'opérateur le réclame depuis une session déjà authentifiée,
-- et le bearer ne part qu'ensuite, en HTTPS, une seule fois. Le QR ne vaut
-- donc rien passé son TTL.
--
-- `organization_id` est NULL tant que personne n'a réclamé : à la création, le
-- runtime ne sait pas encore à quelle organisation il appartiendra. C'est la
-- réclamation, faite avec une session owner/admin, qui l'établit.
create table runtime_enrollments (
  id uuid primary key,
  -- Jamais le secret : seulement son SHA-256, comme les jetons de session.
  secret_hash text not null unique,
  endpoint text not null,
  runtime_name text not null,
  -- Relu par l'opérateur dans son propre terminal avant de confirmer. Sans lui,
  -- faire scanner le QR d'un serveur tiers suffirait à l'inscrire chez la
  -- victime.
  verification_code text not null,
  organization_id uuid references organizations(id) on delete cascade,
  claimed_by uuid references users(id) on delete set null,
  claimed_at timestamptz,
  consumed_at timestamptz,
  runtime_id uuid,
  expires_at timestamptz not null,
  created_ip inet,
  created_at timestamptz not null default now(),
  constraint runtime_enrollments_claim_pair_check
    check ((claimed_at is null) = (organization_id is null)),
  constraint runtime_enrollments_consumed_after_claim_check
    check (consumed_at is null or claimed_at is not null)
);

create index runtime_enrollments_expiry on runtime_enrollments (expires_at);
create index runtime_enrollments_pending_by_ip on runtime_enrollments (created_ip, created_at);

alter table runtime_enrollments enable row level security;
alter table runtime_enrollments force row level security;

-- Deux portes, jamais une troisième :
--   - l'organisation de la session, pour la réclamation et la lecture par
--     l'opérateur ;
--   - le hash du secret présenté, pour le runtime qui n'a aucune session.
-- Le secret n'étant connu que du runtime et du QR, cette seconde porte
-- n'autorise pas l'énumération : sans le hash exact, aucune ligne n'est
-- visible, pas même son existence.
create policy runtime_enrollments_credential on runtime_enrollments to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

-- Le worker purge les enrôlements expirés ou consommés.
create policy runtime_enrollments_worker on runtime_enrollments to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on runtime_enrollments to ohb_api;
grant select, delete on runtime_enrollments to ohb_worker;

insert into schema_migrations(version) values ('0014_runtime_enrollments')
on conflict (version) do nothing;

commit;
