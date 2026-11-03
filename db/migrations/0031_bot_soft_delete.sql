begin;

-- La suppression d'un bot devient un geste en deux temps.
--
-- Jusqu'ici `DELETE /api/bots/:id` effaçait la ligne, et avec elle les fils
-- (cascade de 0004), donc les `hermes_session_id` qui nommaient les sessions
-- sur le runtime du client. Les données restaient sur son VPS et plus
-- personne, ici, ne savait comment les nommer pour les supprimer.
--
-- `deleted_at` est la corbeille : le premier `DELETE` la remplit, la purge
-- explicite (`?purge=1`) supprime la ligne APRÈS avoir supprimé les sessions
-- côté runtime (`DELETE /api/sessions/{id}` du gateway amont).
--
-- INVARIANT tenu par la contrainte : un bot supprimé est toujours archivé.
-- C'est ce qui rend la migration sûre sans toucher une seule des ~25
-- requêtes qui filtrent déjà `archived_at is null` : elles excluent d'office
-- ce qui est en corbeille, sans savoir que la corbeille existe.
alter table bots
  add column deleted_at timestamptz;

alter table bots
  add constraint bots_deleted_implies_archived
  check (deleted_at is null or archived_at is not null);

comment on column bots.deleted_at is
  'Corbeille : l''utilisateur a supprimé ce bot, ses sessions runtime ne sont pas encore purgées. Toujours accompagné de archived_at (contrainte bots_deleted_implies_archived), ce qui le retire de toutes les requêtes qui filtrent archived_at is null.';

-- Les seules lectures qui s'intéressent à la corbeille filtrent dessus
-- (l'écran Archives). Partiel : la corbeille est petite par nature.
create index bots_deleted_at_idx on bots (organization_id, deleted_at)
  where deleted_at is not null;

insert into schema_migrations(version) values ('0031_bot_soft_delete')
on conflict (version) do nothing;

commit;
