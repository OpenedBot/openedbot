begin;

-- Les fils de conversation. Un fil appartient soit à un bot (DM/tâche), soit
-- à un salon, jamais les deux. Les fils de bot portent le cycle de vie des
-- tâches : exactement un fil par défaut actif par bot (route historique
-- `/c/:slug`), plus des tâches libres avec leur propre session Hermes ; les
-- fils de salon restent volontairement hors de ce cycle de vie.

create table threads (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid,
  group_id uuid,
  title text not null,
  hermes_session_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_default boolean not null default false,
  task_status text,
  task_archived_at timestamptz,
  task_created_by_user_id uuid,
  task_creation_idempotency_key uuid,
  task_version bigint not null default 0 check (task_version >= 0),
  unique (organization_id, id),
  unique (organization_id, group_id),
  unique (organization_id, hermes_session_id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, group_id) references bot_groups(organization_id, id) on delete cascade,
  check ((bot_id is not null)::integer + (group_id is not null)::integer = 1),
  constraint threads_task_status_check check (
    (bot_id is null and task_status is null and is_default = false
      and task_archived_at is null and task_created_by_user_id is null
      and task_creation_idempotency_key is null)
    or
    (bot_id is not null and task_status in ('active', 'archived'))
  ),
  constraint threads_task_archive_check check (
    (task_status = 'archived') = (task_archived_at is not null)
  ),
  constraint threads_default_task_check check (
    not is_default or (bot_id is not null and task_status = 'active')
  ),
  constraint threads_task_creator_fk foreign key (organization_id, task_created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (task_created_by_user_id)
);

-- Exactement une route historique/par défaut par bot : chaque `/c/:slug` et
-- chaque intégration qui stocke BotDto.threadId reste déterministe.
create unique index threads_one_default_task_per_bot_idx
  on threads (organization_id, bot_id)
  where bot_id is not null and is_default;

create index threads_bot_tasks_activity_idx
  on threads (organization_id, bot_id, task_status, updated_at desc, created_at desc)
  where bot_id is not null;

-- Un retry client du même membre rend la même tâche. La clé UUID n'est jamais
-- recyclée par l'archivage : un 201 perdu ne crée pas de second contexte.
create unique index threads_task_creation_idempotency_idx
  on threads (organization_id, bot_id, task_created_by_user_id, task_creation_idempotency_key)
  where bot_id is not null and task_creation_idempotency_key is not null;

-- Watermark de lecture par membre et par fil. Une date, plutôt qu'un simple
-- booléen : un nouvel événement arrivé pendant l'accusé reste non lu.
create table thread_reads (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  thread_id uuid not null,
  read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, thread_id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade
);

-- Préférence personnelle et réversible : masquer ne modifie ni le bot/salon,
-- ni le fil, ni son historique. La clé composite empêche aussi de viser un
-- fil ou un utilisateur hors de l'organisation courante.
create table thread_hides (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  thread_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (organization_id, user_id, thread_id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade
);

alter table threads enable row level security;
alter table threads force row level security;
alter table thread_reads enable row level security;
alter table thread_reads force row level security;
alter table thread_hides enable row level security;
alter table thread_hides force row level security;

create policy threads_tenant on threads to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy threads_worker on threads to openedbot_worker using (true) with check (true);

create policy thread_reads_tenant on thread_reads to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy thread_hides_tenant on thread_hides to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on threads to openedbot_api;
grant select, insert, update, delete on threads to openedbot_worker;
grant select, insert, update, delete on thread_reads to openedbot_api;
grant select, insert, update, delete on thread_hides to openedbot_api;

insert into schema_migrations(version) values ('0004_threads')
on conflict (version) do nothing;

commit;
