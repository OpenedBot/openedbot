-- La mémoire d'un bot est celle de son runtime Hermes (MEMORY.md / USER.md du
-- profil, outil `memory`), lue et corrigée par le lien. Le régime OHB
-- (faits en base, lignes `remember:`, approbation, extraction automatique)
-- est retiré : la table et ses colonnes tombent. Les décisions déjà
-- journalisées (`decisions.envelope` de kind memory_fact) restent lisibles.
begin;
drop table if exists bot_memories;
drop index if exists threads_memory_extract_due_idx;
alter table threads
  drop column if exists memory_extract_due_at,
  drop column if exists memory_extract_cursor_at;
alter table organizations
  drop column if exists memory_extract_enabled;
alter table bots
  drop column if exists memory_extract_enabled,
  drop column if exists memory_extract_model;
insert into schema_migrations(version) values ('0061_runtime_memory_only')
on conflict (version) do nothing;
commit;
