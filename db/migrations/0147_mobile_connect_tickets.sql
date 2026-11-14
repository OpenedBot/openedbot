begin;

-- Connexion d'un téléphone par QR (« Mobile Connect »), comme l'app de référence et l'app de référence :
-- un membre déjà authentifié dans la console demande un ticket ; la console
-- l'affiche en QR (`openedbot://join?api=…&ticket=<id>.<secret>`) ; l'app le scanne et
-- l'échange, une seule fois et avant son expiration, contre un code natif PKCE
-- (le même que celui de la connexion par mot de passe), puis contre une session.
--
-- Le ticket ouvre une session AU NOM de la personne qui l'a créé, dans son
-- organisation : il vaut donc autant qu'un mot de passe pendant ses dix minutes.
-- La base ne garde que le SHA-256 du secret, comme pour les enrôlements.
create table mobile_connect_tickets (
  id uuid primary key,
  secret_hash text not null unique,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index mobile_connect_tickets_expiry on mobile_connect_tickets (expires_at);

alter table mobile_connect_tickets enable row level security;
alter table mobile_connect_tickets force row level security;

-- Deux portes : l'organisation de la session qui crée le ticket, ou le hash du
-- secret présenté par le téléphone, qui n'a pas encore de session. Sans le hash
-- exact, aucune ligne n'est visible.
create policy mobile_connect_tickets_credential on mobile_connect_tickets to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or secret_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

create policy mobile_connect_tickets_worker on mobile_connect_tickets to openedbot_worker
  using (true) with check (true);

grant select, insert, update, delete on mobile_connect_tickets to openedbot_api;
grant select, delete on mobile_connect_tickets to openedbot_worker;

insert into schema_migrations(version) values ('0147_mobile_connect_tickets')
on conflict (version) do nothing;

commit;
