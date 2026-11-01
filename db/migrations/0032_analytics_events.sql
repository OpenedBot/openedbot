begin;

-- Le fait analytique du produit : une ligne append-only par événement métier
-- notable (inscription, création d'organisation, message envoyé, run démarré
-- ou terminé, runtime lié). Les rollups et les écrans staff se construisent
-- PAR-DESSUS cette table, jamais à la place.
--
-- `cursor` est une identité monotone comme sur `run_events` : elle donne un
-- ordre de lecture stable aux agrégations incrémentales, indépendant de
-- `occurred_at` (que l'émetteur peut antidater).
create table analytics_events (
  cursor          bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_kind      text not null check (actor_kind in ('user','bot','system','staff')),
  actor_id        uuid,
  name            text not null,
  subject_kind    text,
  subject_id      uuid,
  props           jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now()
);

-- Le tableau de bord d'un tenant lit une plage de temps de SON organisation.
create index analytics_events_org_occurred_idx
  on analytics_events (organization_id, occurred_at desc);
-- Les rollups par événement balayent un nom sur une plage, tous tenants
-- confondus (rôle worker/staff).
create index analytics_events_name_occurred_idx
  on analytics_events (name, occurred_at desc);

comment on table analytics_events is
  'Fait analytique append-only du produit : un événement métier par ligne, purgé à 90 jours par le worker. `props` ne contient JAMAIS de texte utilisateur (contenu de message, e-mail, prompt, nom affiché, jeton) — uniquement des dimensions et des mesures.';

alter table analytics_events enable row level security;
alter table analytics_events force row level security;

create policy analytics_events_tenant on analytics_events to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy analytics_events_worker on analytics_events to ohb_worker
  using (true) with check (true);
-- L'émetteur de l'API vide sa file HORS de toute transaction métier, donc sans
-- `app.organization_id` posé : un lot mélange plusieurs organisations. Cette
-- politique n'ouvre QUE l'écriture (les politiques permissives s'additionnent) ;
-- la lecture reste strictement bornée par `analytics_events_tenant`, et
-- `organization_id` est une FK non nulle : on ne peut pas fabriquer un fait
-- pour un tenant qui n'existe pas.
create policy analytics_events_api_append on analytics_events for insert to ohb_api
  with check (true);

grant select, insert, update, delete on analytics_events to ohb_api;
grant select, insert, update, delete on analytics_events to ohb_worker;
grant usage, select on sequence analytics_events_cursor_seq to ohb_api;
grant usage, select on sequence analytics_events_cursor_seq to ohb_worker;

insert into schema_migrations(version) values ('0032_analytics_events')
on conflict (version) do nothing;

commit;
