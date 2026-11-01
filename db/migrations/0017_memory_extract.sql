begin;

-- Passe d'extraction mémoire OHB-owned : un second run, après le tour, qui
-- écrit des faits dans `bot_memories` sans lever le refus des toolsets
-- `memory` / `session_search`. Le discriminant `step_kind` permet de ne pas
-- poser de bulle, de ne pas avancer un salon, et de ne pas parser `@slug`.
-- `persona_draft` est le même genre de run de service (brouillon de persona,
-- jamais enregistré sans confirmation humaine).
--
-- `scope` réplique le partage MEMORY.md / USER.md de Hermes. Le debounce vit
-- sur le fil (`memory_extract_due_at`) pour coalescer N tours en une passe.
-- Le drapeau d'organisation est éteint par défaut : on observe un bot avant
-- de généraliser.

alter table runs drop constraint runs_step_kind_check;
alter table runs add constraint runs_step_kind_check
  check (step_kind is null or step_kind in (
    'root', 'delegated', 'continuation', 'group', 'memory', 'persona_draft'
  ));

alter table bot_memories
  add column scope text not null default 'bot'
    constraint bot_memories_scope_check check (scope in ('bot', 'user'));

alter table threads
  add column memory_extract_due_at timestamptz;

alter table organizations
  add column memory_extract_enabled boolean not null default false;

alter table bots
  add column memory_extract_enabled boolean not null default true,
  add column memory_extract_model text;

create index threads_memory_extract_due_idx
  on threads (memory_extract_due_at)
  where memory_extract_due_at is not null;

insert into schema_migrations(version) values ('0017_memory_extract')
on conflict (version) do nothing;

commit;
