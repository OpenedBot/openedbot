begin;

-- Éditer ou régénérer ne mute jamais le transcript source et ne reprend
-- jamais la session provider qui a déjà consommé sa fin abandonnée. Une
-- version vit dans une tâche/fil neuf avec une session Hermes neuve : le
-- préfixe sélectionné est copié comme historique immuable, puis un message
-- utilisateur, un workflow et un run frais y sont ajoutés. Cette table est
-- l'arête de provenance entre ces tâches et donne à l'UI une famille de
-- versions stable.
create table message_versions (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  root_thread_id uuid not null,
  root_message_id uuid not null,
  parent_thread_id uuid not null,
  parent_message_id uuid not null,
  branch_thread_id uuid not null,
  branch_message_id uuid not null,
  run_id uuid not null,
  workflow_id uuid not null,
  created_by_user_id uuid,
  idempotency_key uuid not null,
  request_hash text not null,
  kind text not null check (kind in ('edit', 'regenerate')),
  ordinal smallint not null check (ordinal between 1 and 19),
  source_sequence bigint not null check (source_sequence >= 0),
  copied_message_count smallint not null check (copied_message_count between 0 and 200),
  prefix_truncated boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, branch_thread_id),
  unique (organization_id, branch_message_id),
  constraint message_versions_run_key unique (organization_id, run_id),
  constraint message_versions_workflow_key unique (organization_id, workflow_id),
  constraint message_versions_creator_idempotency_key
    unique (organization_id, created_by_user_id, idempotency_key),
  unique (organization_id, root_thread_id, root_message_id, ordinal),
  constraint message_versions_root_message_fk
    foreign key (organization_id, root_thread_id, root_message_id)
    references messages(organization_id, thread_id, id) on delete cascade,
  constraint message_versions_parent_message_fk
    foreign key (organization_id, parent_thread_id, parent_message_id)
    references messages(organization_id, thread_id, id) on delete cascade,
  constraint message_versions_branch_message_fk
    foreign key (organization_id, branch_thread_id, branch_message_id)
    references messages(organization_id, thread_id, id) on delete cascade,
  constraint message_versions_branch_thread_fk
    foreign key (organization_id, branch_thread_id)
    references threads(organization_id, id) on delete cascade,
  constraint message_versions_run_fk
    foreign key (organization_id, run_id)
    references runs(organization_id, id) on delete cascade,
  constraint message_versions_workflow_fk
    foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  constraint message_versions_creator_fk
    foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id)
    on delete set null (created_by_user_id),
  check (root_thread_id <> branch_thread_id),
  check (parent_thread_id <> branch_thread_id),
  check (root_message_id <> branch_message_id),
  check (parent_message_id <> branch_message_id),
  constraint message_versions_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$')
);

create index message_versions_parent_idx
  on message_versions (organization_id, parent_thread_id, parent_message_id);

alter table message_versions enable row level security;
alter table message_versions force row level security;

create policy message_versions_tenant on message_versions to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- Le worker ne lit que `prefix_truncated` : quand le préfixe copié dépasse sa
-- fenêtre bornée, il injecte le même avertissement honnête de perte
-- d'historique qu'un long fil ordinaire. Il ne réécrit jamais la provenance.
grant select, insert on message_versions to openedbot_api;
create policy message_versions_worker on message_versions to openedbot_worker
  using (true) with check (true);
grant select on message_versions to openedbot_worker;

insert into schema_migrations(version) values ('0008_message_versions')
on conflict (version) do nothing;

commit;
