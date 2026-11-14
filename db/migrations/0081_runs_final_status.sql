-- Un run terminé ne change plus de statut.
--
-- `runs` a quatorze fichiers écrivains, répartis entre l'API et le worker, et
-- chaque `update` porte sa propre garde (`status in (...)`, bail, génération).
-- Relevé exhaustif au moment de cette migration : aucune écriture ne fait
-- sortir un run de `completed` ou de `failed`. `cancelled` n'est PAS final :
-- le rejeu d'un steer non livré (`run-steering.ts`) remet en file un run
-- annulé `steered_into_active`, et une décision d'approbation perdue
-- (`runner.ts`) le passe en `unknown`.
--
-- Cette garde tient l'invariant là où tous les écrivains passent, plutôt que
-- dans quatorze conventions. Une écriture qui tenterait de rouvrir un run
-- terminé échoue avec `23514` au lieu de réécrire l'histoire d'un fil. Les
-- colonnes autres que `status` (mise à `null` de `bot_id` par une purge,
-- `completion_kind`) restent libres.
begin;

create or replace function guard_run_final_status() returns trigger
language plpgsql
as $$
begin
  raise exception 'run % is % and cannot become %', old.id, old.status, new.status
    using errcode = '23514', constraint = 'runs_final_status';
end;
$$;

drop trigger if exists runs_final_status on runs;
create trigger runs_final_status
  before update of status on runs
  for each row
  when (old.status in ('completed', 'failed') and new.status is distinct from old.status)
  execute function guard_run_final_status();

insert into schema_migrations(version) values ('0081_runs_final_status') on conflict (version) do nothing;

commit;
