begin;

-- Un bot, un fil. La notion de « session extra » (`/cs/:botId?task=`) est
-- retirée du produit : le fil permanent se compacte au lieu de déborder
-- (`modules/conversation/src/domain/thread-compaction.ts` : mémoire durable, puis
-- résumé du passé, puis les tours récents intacts), donc découper une tâche
-- dans un fil à côté n'achète plus rien.
--
-- PERTE DE DONNÉES ASSUMÉE ET VALIDÉE PAR L'UTILISATEUR : les sessions extra
-- existantes sont supprimées, avec leurs messages, leurs runs et leur
-- compaction (tout est en `on delete cascade` depuis `threads`). Cette
-- migration n'a pas d'inverse.
--
-- Le ciblage est `task_creation_idempotency_key is not null` et NON
-- `is_default = false` : les branches de variante de message
-- (`message-version-routes.ts`, mode `edit` / `regenerate`) sont elles aussi
-- des fils non-default d'un bot, mais elles n'ont jamais de clé de création,
-- ce sont des versions de message, pas des sessions, et elles restent.

delete from threads
 where bot_id is not null
   and is_default = false
   and task_creation_idempotency_key is not null;

-- `is_default` RESTE : c'est elle qui identifie le fil permanent, et
-- `threads_one_default_task_per_bot_idx` reste la garantie « un seul fil par
-- bot ». Seules les colonnes de session MULTIPLE partent.

alter table threads drop constraint if exists threads_task_status_check;
alter table threads drop constraint if exists threads_task_archive_check;
alter table threads drop constraint if exists threads_default_task_check;
alter table threads drop constraint if exists threads_task_creator_fk;

drop index if exists threads_bot_tasks_activity_idx;
drop index if exists threads_task_creation_idempotency_idx;

alter table threads
  drop column if exists task_status,
  drop column if exists task_archived_at,
  drop column if exists task_created_by_user_id,
  drop column if exists task_creation_idempotency_key,
  drop column if exists task_version;

-- La contrainte perd sa référence au statut de tâche, mais garde ce qu'elle
-- disait vraiment : un fil par défaut appartient à un bot. Les branches de
-- variante restent des fils non-default légitimes.
alter table threads add constraint threads_default_task_check check (
  not is_default or bot_id is not null
);

-- L'ordre d'activité d'un bot reste lu (roster, aperçu) : l'index survit à la
-- disparition de `task_status`, sans lui.
create index if not exists threads_bot_activity_idx
  on threads (organization_id, bot_id, updated_at desc, created_at desc)
  where bot_id is not null;

insert into schema_migrations(version) values ('0021_drop_bot_tasks')
on conflict (version) do nothing;

commit;
