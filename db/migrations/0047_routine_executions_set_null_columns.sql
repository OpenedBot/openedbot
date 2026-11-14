begin;

-- Mesuré le 2026-09-04 au navigateur : supprimer un salon (ou purger un bot)
-- qui a tiré une routine échouait en 500. Les trois clés composites de 0043
-- disaient `on delete set null` sans nommer la colonne : PostgreSQL annule
-- alors TOUTES les colonnes référençantes, `organization_id` compris, qui est
-- `not null`. Même forme que 0003 (`on delete set null (created_by_user_id)`).

alter table routine_executions
  drop constraint if exists routine_executions_organization_id_workflow_id_fkey,
  drop constraint if exists routine_executions_organization_id_run_id_fkey,
  drop constraint if exists routine_executions_organization_id_thread_id_fkey;

alter table routine_executions
  add constraint routine_executions_organization_id_workflow_id_fkey
    foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete set null (workflow_id),
  add constraint routine_executions_organization_id_run_id_fkey
    foreign key (organization_id, run_id)
    references runs(organization_id, id) on delete set null (run_id),
  add constraint routine_executions_organization_id_thread_id_fkey
    foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete set null (thread_id);

insert into schema_migrations(version) values ('0047_routine_executions_set_null_columns')
on conflict (version) do nothing;

commit;
