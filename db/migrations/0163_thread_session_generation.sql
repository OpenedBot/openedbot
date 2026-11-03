begin;

-- Une bascule de toolset, de skill ou de serveur MCP doit valoir dès le
-- prochain message, y compris dans un fil déjà commencé.
--
-- Hermes fige, par session, le prompt système (qui porte l'index des skills)
-- et le tableau des outils, pour garder le cache du fournisseur : une session
-- en cours ne voit jamais une capacité changée après son premier tour. Hermes
-- relit pourtant sa config à chaque requête, et openedbot lui renvoie
-- l'historique du fil à chaque tour : ouvrir une NOUVELLE session suffit, au
-- prix d'un seul défaut de cache.
--
-- Le broker du lien voit chaque écriture de capacité relayée et marque :
--   - runtimes.capabilities_changed_at : la racine de l'hôte (toolsets,
--     serveurs MCP et identifiants racine, redémarrage du gateway) ;
--   - runtimes.profile_capabilities_changed_at : par profil, { slug: instant }.
-- Au départ d'un run, le worker compare ces instants à
-- threads.hermes_session_opened_at : une capacité changée APRÈS l'ouverture de
-- la session du fil fait passer le fil à la génération suivante, dont la clé
-- de session est `<hermes_session_id>:gen<n>` (la génération 0 garde la clé
-- d'origine). La clé d'une génération > 0 est posée sur le run
-- (runs.execution_session_key), comme celle d'un run d'accueil.
--
-- Les droits et politiques RLS de runtimes et threads couvrent les colonnes.
alter table runtimes
  add column if not exists capabilities_changed_at timestamptz,
  add column if not exists profile_capabilities_changed_at jsonb not null default '{}'::jsonb;

alter table runtimes
  drop constraint if exists runtimes_profile_capabilities_changed_at_check;
alter table runtimes
  add constraint runtimes_profile_capabilities_changed_at_check
  check (jsonb_typeof(profile_capabilities_changed_at) = 'object');

comment on column runtimes.capabilities_changed_at is
  'Last relayed capability write at the host root (toolsets, MCP servers, root credentials, gateway restart).';
comment on column runtimes.profile_capabilities_changed_at is
  'Last relayed capability write per Hermes profile: {"<slug>": "<timestamptz>"}.';

alter table threads
  add column if not exists hermes_session_generation integer not null default 0,
  add column if not exists hermes_session_opened_at timestamptz;

alter table threads
  drop constraint if exists threads_hermes_session_generation_check;
alter table threads
  add constraint threads_hermes_session_generation_check check (hermes_session_generation >= 0);

comment on column threads.hermes_session_generation is
  'Hermes session generation of the thread: 0 uses hermes_session_id, n > 0 uses hermes_session_id || '':gen'' || n.';
comment on column threads.hermes_session_opened_at is
  'When the current generation''s Hermes session served its first run (null: not yet, or before 0163).';

insert into schema_migrations(version) values ('0163_thread_session_generation') on conflict (version) do nothing;
commit;
