-- Historique des tirs, RLS tenant, cascade a la suppression de routine.
-- Reutilise tenant-a / tenant-b. Pas d apostrophe isolee dans les commentaires.

create temp table routine_exec_proof (own int, other int, after_delete int);
insert into routine_exec_proof values (-1, -1, -1);
grant select, insert, update on routine_exec_proof to openedbot_api;

insert into routines (
  id, organization_id, bot_id, name, schedule, timezone, message, enabled
) values (
  '92000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021',
  'Revue A', '0 9 * * 1-5', 'UTC', 'Point.', true
), (
  '92000000-0000-4000-8000-000000000202',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000022',
  'Revue B', '0 9 * * 1-5', 'UTC', 'Point.', true
);

insert into routine_executions (
  id, organization_id, routine_id, outcome, trigger, error_code, error_message
) values (
  '92000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000201',
  'abandoned', 'scheduled', 'ROUTINE_BUSY_RETRIES_EXHAUSTED',
  'Fil occupe : 10 reports de 60 s epuises, occurrence abandonnee.'
), (
  '92000000-0000-4000-8000-000000000212',
  '20000000-0000-4000-8000-000000000002',
  '92000000-0000-4000-8000-000000000202',
  'fired', 'scheduled', null, null
);

set role openedbot_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update routine_exec_proof set own = (select count(*) from routine_executions);
reset role;

set role openedbot_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update routine_exec_proof set other = (
  select count(*) from routine_executions
   where organization_id = '20000000-0000-4000-8000-000000000002'
);
reset role;

delete from routines where id = '92000000-0000-4000-8000-000000000201';
update routine_exec_proof set after_delete = (
  select count(*) from routine_executions
   where id = '92000000-0000-4000-8000-000000000211'
);

select own || '/' || other || '/' || after_delete from routine_exec_proof;
