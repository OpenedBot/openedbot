begin;

-- Résumé de fil (context pack) : un watermark par thread. Le replay brut
-- (200 messages / 48 000 caractères) restait muet au-delà ; ce résumé
-- remplace l'aveu « N messages dropped » dès qu'un compact a réussi.
-- Un seul résumé courant, pas d'historique de compact.

alter table runs drop constraint runs_step_kind_check;
alter table runs add constraint runs_step_kind_check
  check (step_kind is null or step_kind in (
    'root', 'delegated', 'continuation', 'group', 'memory', 'persona_draft', 'compaction'
  ));

create table thread_compactions (
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  summary text not null,
  compacted_through_sequence integer not null,
  source_message_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, thread_id),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  constraint thread_compactions_sequence_nonneg check (compacted_through_sequence >= 0),
  constraint thread_compactions_count_nonneg check (source_message_count >= 0),
  constraint thread_compactions_summary_length check (char_length(summary) between 1 and 16000)
);

alter table thread_compactions enable row level security;
alter table thread_compactions force row level security;

create policy thread_compactions_tenant on thread_compactions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy thread_compactions_worker on thread_compactions to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on thread_compactions to ohb_api;
grant select, insert, update, delete on thread_compactions to ohb_worker;

insert into schema_migrations(version) values ('0020_thread_compactions')
on conflict (version) do nothing;

commit;
