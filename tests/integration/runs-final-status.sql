-- Garde runs_final_status, livree par 0081_runs_final_status.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici, sous le role ohb_worker qui porte la plupart des
-- ecritures de runs :
--   1. completed_reopen : un run completed ne repasse pas en file ;
--   2. failed_cancel    : un run failed ne devient pas cancelled ;
--   3. cancelled_replay : un run cancelled repasse en file (rejeu de steer) ;
--   4. final_columns    : une colonne autre que status reste modifiable sur
--                         un run termine ;
--   5. running_complete : la transition ordinaire running vers completed passe.
--
-- La preuve insere son propre espace ; elle vient avant la derniere connexion.

insert into organizations (id, slug, name) values
  ('81000000-0000-4000-8000-000000000001', 'runs-final-status', 'Runs final status');
insert into sections (id, organization_id, name, position) values
  ('81000000-0000-4000-8000-000000000011', '81000000-0000-4000-8000-000000000001', 'Final', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('81000000-0000-4000-8000-000000000021', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000011', 'Final bot', 'final-bot', 'final-profile', 0);
insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values
  ('81000000-0000-4000-8000-000000000031', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000021', 'Final thread', 'final-session', true);
insert into runs (id, organization_id, thread_id, bot_id, input, status) values
  ('81000000-0000-4000-8000-000000000041', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000031', '81000000-0000-4000-8000-000000000021', 'done', 'completed'),
  ('81000000-0000-4000-8000-000000000042', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000031', '81000000-0000-4000-8000-000000000021', 'broken', 'failed'),
  ('81000000-0000-4000-8000-000000000043', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000031', '81000000-0000-4000-8000-000000000021', 'steered', 'cancelled'),
  ('81000000-0000-4000-8000-000000000044', '81000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000031', '81000000-0000-4000-8000-000000000021', 'live', 'running');

create temp table runs_final_status_proof (
  completed_reopen text default 'allowed',
  failed_cancel text default 'allowed'
);
insert into runs_final_status_proof default values;
grant select, update on runs_final_status_proof to ohb_worker;

set role ohb_worker;
do $proof$
begin
  update runs set status = 'queued' where id = '81000000-0000-4000-8000-000000000041';
exception when check_violation then
  update runs_final_status_proof set completed_reopen = 'denied';
end;
$proof$;
do $proof$
begin
  update runs set status = 'cancelled' where id = '81000000-0000-4000-8000-000000000042';
exception when check_violation then
  update runs_final_status_proof set failed_cancel = 'denied';
end;
$proof$;
update runs set status = 'queued' where id = '81000000-0000-4000-8000-000000000043';
update runs set status = 'completed', completion_kind = 'final' where id = '81000000-0000-4000-8000-000000000041';
update runs set status = 'completed' where id = '81000000-0000-4000-8000-000000000044';
reset role;

select p.completed_reopen || '/' || p.failed_cancel || '/'
       || (select status from runs where id = '81000000-0000-4000-8000-000000000043') || '/'
       || (select completion_kind from runs where id = '81000000-0000-4000-8000-000000000041') || '/'
       || (select status from runs where id = '81000000-0000-4000-8000-000000000044')
  from runs_final_status_proof p;
