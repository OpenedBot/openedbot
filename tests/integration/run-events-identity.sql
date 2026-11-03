-- Identite et fencing de run_events, livres par 0092_run_events_identity.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. stamp_step   : une etape de workflow ecrite par ohb_worker sans bail
--                     recoit bot, tour du run racine, cle de session du run et
--                     generation courante ;
--   2. stamp_dm     : un run hors workflow est son propre tour et retombe sur
--                     la session du fil ;
--   3. forged       : une identite fournie par l ecrivain est ecrasee par
--                     celle du run ;
--   4. stale_lease  : une ligne ecrite sous un bail perime est refusee (23514) ;
--   5. fresh_lease  : la meme ligne sous le bail courant passe ;
--   6. replayed     : la meme (run_id, sequence) rejouee ne cree pas de doublon ;
--   7. api_stamp    : ohb_api, sous son tenant, ecrit et voit la ligne estampillee ;
--   8. other_tenant : un autre tenant ne voit aucune de ces lignes.
--
-- La preuve insere son propre espace ; elle vient avant la derniere connexion.

insert into organizations (id, slug, name) values
  ('91000000-0000-4000-8000-000000000001', 'run-events-identity', 'Run events identity'),
  ('91000000-0000-4000-8000-000000000002', 'run-events-identity-b', 'Run events identity B');
insert into sections (id, organization_id, name, position) values
  ('91000000-0000-4000-8000-000000000011', '91000000-0000-4000-8000-000000000001', 'Identity', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('91000000-0000-4000-8000-000000000021', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000011', 'Identity bot', 'identity-bot', 'identity-profile', 0);
insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values
  ('91000000-0000-4000-8000-000000000031', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000021', 'Identity thread', 'ohb:identity:thread', true);

begin;
insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind) values
  ('91000000-0000-4000-8000-000000000051', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000031', '91000000-0000-4000-8000-000000000041',
   '91000000-0000-4000-8000-000000000021', 'dm');
insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
                  execution_session_key, lease_generation) values
  ('91000000-0000-4000-8000-000000000041', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000031', '91000000-0000-4000-8000-000000000021', 'root', 'completed',
   '91000000-0000-4000-8000-000000000051', 0, 'root', 'ohb:identity:workflow', 0),
  ('91000000-0000-4000-8000-000000000042', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000031', '91000000-0000-4000-8000-000000000021', 'step', 'running',
   '91000000-0000-4000-8000-000000000051', 1, 'continuation', 'ohb:identity:workflow', 2);
commit;
insert into runs (id, organization_id, thread_id, bot_id, input, status) values
  ('91000000-0000-4000-8000-000000000043', '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000031', '91000000-0000-4000-8000-000000000021', 'dm', 'completed');

create temp table run_events_identity_proof (
  stale_lease text default 'accepted',
  api_stamp text,
  other_tenant text
);
insert into run_events_identity_proof default values;
grant select, update on run_events_identity_proof to ohb_worker, ohb_api;

set role ohb_worker;
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000042', 0, 'agent.message', '{}'::jsonb, now());
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000043', 0, 'run.completed', '{}'::jsonb, now());
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at,
                        bot_id, turn_id, session_key) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000043', 1, 'system.notice', '{}'::jsonb, now(),
   '91000000-0000-4000-8000-000000000099', '91000000-0000-4000-8000-000000000099', 'forged');
do $proof$
begin
  insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation)
  values ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
          '91000000-0000-4000-8000-000000000042', 1, 'agent.message', '{}'::jsonb, now(), 1);
exception when check_violation then
  update run_events_identity_proof set stale_lease = 'denied';
end;
$proof$;
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000042', 1, 'agent.message', '{}'::jsonb, now(), 2);
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000042', 1, 'agent.message', '{"again":true}'::jsonb, now(), 2)
on conflict (organization_id, run_id, sequence) do nothing;
reset role;

set role ohb_api;
select set_config('app.organization_id', '91000000-0000-4000-8000-000000000001', false) \g /dev/null
insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at) values
  ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
   '91000000-0000-4000-8000-000000000043', 2, 'system.notice', '{}'::jsonb, now());
update run_events_identity_proof
   set api_stamp = (select turn_id::text || '|' || lease_generation::text from run_events
                     where run_id = '91000000-0000-4000-8000-000000000043' and sequence = 2);
select set_config('app.organization_id', '91000000-0000-4000-8000-000000000002', false) \g /dev/null
update run_events_identity_proof
   set other_tenant = (select count(*)::text from run_events
                        where run_id in ('91000000-0000-4000-8000-000000000042',
                                         '91000000-0000-4000-8000-000000000043'));
reset role;

select (select case when bot_id = '91000000-0000-4000-8000-000000000021'
                     and turn_id = '91000000-0000-4000-8000-000000000041'
                     and session_key = 'ohb:identity:workflow' and lease_generation = 2
                    then 'step' else 'wrong:' || coalesce(turn_id::text, 'null') end
          from run_events where run_id = '91000000-0000-4000-8000-000000000042' and sequence = 0)
       || '/' ||
       (select case when turn_id = run_id and session_key = 'ohb:identity:thread' and lease_generation = 0
                    then 'dm' else 'wrong:' || coalesce(session_key, 'null') end
          from run_events where run_id = '91000000-0000-4000-8000-000000000043' and sequence = 0)
       || '/' ||
       (select case when bot_id = '91000000-0000-4000-8000-000000000021' and turn_id = run_id
                     and session_key = 'ohb:identity:thread'
                    then 'overwritten' else 'forged' end
          from run_events where run_id = '91000000-0000-4000-8000-000000000043' and sequence = 1)
       || '/' || p.stale_lease
       || '/' ||
       (select count(*)::text from run_events
         where run_id = '91000000-0000-4000-8000-000000000042' and sequence = 1 and lease_generation = 2
           and payload = '{}'::jsonb)
       || '/' || p.api_stamp
       || '/' || p.other_tenant
  from run_events_identity_proof p;
