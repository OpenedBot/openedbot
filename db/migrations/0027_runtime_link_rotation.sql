begin;

-- Rotation du jeton de lien et journal des événements du lien connecteur.
--
-- Calqué sur hermes-agent (`gateway/relay/auth.py`) : plusieurs secrets
-- acceptés à la fois, l'ancien pendant une fenêtre de grâce. Une rotation
-- glisse le hash courant dans `link_token_previous_hash`, pose sa date
-- d'expiration, et écrit le nouveau hash dans `link_token_hash`. L'hôte qui
-- se reconnecte avec l'ancien jeton pendant la grâce est accepté ; le worker
-- efface l'ancien hash une fois la grâce passée (`expireRotatedLinkTokens`).
-- Le jeton lui-même n'est jamais stocké : seulement ses SHA-256.
alter table runtimes
  add column link_token_previous_hash text unique,
  add column link_token_rotated_at timestamptz,
  add column link_token_previous_expires_at timestamptz;

comment on column runtimes.link_token_previous_hash is
  'SHA-256 du jeton de lien PRÉCÉDENT, accepté jusqu''à link_token_previous_expires_at ; NULL hors rotation.';
comment on column runtimes.link_token_rotated_at is
  'Dernière rotation du jeton de lien ; NULL si jamais tourné.';
comment on column runtimes.link_token_previous_expires_at is
  'Fin de la fenêtre de grâce de l''ancien jeton ; le worker efface le hash précédent au-delà.';

-- La porte du jeton (0024) accepte aussi l'ancien hash : la ligne reste
-- visible au connecteur qui n'a pas encore reçu `link.rotate`. La borne
-- temporelle est vérifiée par la requête de montée, pas par la politique.
drop policy runtimes_link_credential on runtimes;
create policy runtimes_link_credential on runtimes to openedbot_api
  using (
    link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

-- Le journal du lien : qui s'est connecté, d'où, et ce qui a remplacé quoi.
-- `hijack_suspected` est écrit par le broker quand un remplacement vient
-- d'une autre adresse ou quand les remplacements s'enchaînent ; l'écran le
-- montre comme un bandeau, et l'opérateur fait tourner le jeton.
create table runtime_link_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  kind text not null
    constraint runtime_link_events_kind_check
    check (kind in ('connected', 'replaced', 'disconnected', 'revoked', 'rotated', 'hijack_suspected')),
  ip text,
  agent text,
  previous_ip text,
  occurred_at timestamptz not null default now()
);

create index runtime_link_events_runtime_idx
  on runtime_link_events (organization_id, runtime_id, occurred_at desc);

comment on table runtime_link_events is
  'Journal du lien connecteur par runtime : connexions, remplacements, révocations, rotations, soupçons de détournement.';

alter table runtime_link_events enable row level security;
alter table runtime_link_events force row level security;

create policy runtime_link_events_tenant on runtime_link_events to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_link_events_worker on runtime_link_events to openedbot_worker
  using (true) with check (true);

grant select, insert, update, delete on runtime_link_events to openedbot_api;
grant select, insert, update, delete on runtime_link_events to openedbot_worker;

insert into schema_migrations(version) values ('0027_runtime_link_rotation')
on conflict (version) do nothing;

commit;
