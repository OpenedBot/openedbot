begin;

-- Réglages › Connecteurs lit l'inventaire de l'hôte (toolsets, serveurs et
-- connexions MCP, skills) dans `runtime_read_snapshots`. Une lecture froide de
-- l'hôte démarre un interpréteur Python (2,6 s mesurées le 02-11-2026), et
-- l'instantané n'était servi que jusqu'à 11 minutes : au-delà, l'écran
-- attendait l'hôte.
--
-- L'hôte dit désormais lui-même quand cet inventaire change : son connecteur
-- interroge l'empreinte de l'opérateur (noms, tailles et dates des fichiers
-- concernés, jamais leur contenu) et envoie `inventory.changed` quand elle
-- bouge, et une fois à chaque connexion. Le broker l'inscrit ici, puis l'API
-- relit l'hôte en arrière-plan.
--
-- `inventory_changed_at` sert deux fois :
--   - un instantané observé avant cet instant est périmé (servi, et relu en
--     arrière-plan) ;
--   - un instantané observé APRÈS le dernier signal d'une connexion encore en
--     cours (`inventory_changed_at >= link_connected_at`) vient d'un hôte qui
--     surveille : il reste servi sans borne d'âge courte.
--
-- Les droits SELECT/UPDATE sur runtimes et leurs politiques RLS couvrent déjà
-- la colonne.
alter table runtimes
  add column if not exists inventory_changed_at timestamptz;

comment on column runtimes.inventory_changed_at is
  'Last inventory.changed signal from the host connector (files behind toolsets, MCP and skills moved). Carries no data.';

insert into schema_migrations(version) values ('0160_runtime_inventory_changed') on conflict (version) do nothing;
commit;
