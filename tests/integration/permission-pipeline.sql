-- PERM2-1 (0138): the permission pipeline flag, the bot revision, the worker
-- guard and the backoffice switch. Executed on the disposable integration
-- database after every migration. Prints one line of results.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table pipeline_proof (step int primary key, value text not null);
grant select, insert, update on pipeline_proof to ohb_api, ohb_worker;

insert into staff_users (id, email, password_hash, display_name) values
  ('e7000000-0000-4000-8000-000000000001', 'pipeline-staff@example.test', 'x', 'Pipeline Staff');

insert into organizations (id, slug, name) values
  ('e7000000-0000-4000-8000-000000000010', 'pipeline-acme', 'Acme');
insert into sections (id, organization_id, name, position) values
  ('e7000000-0000-4000-8000-000000000011', 'e7000000-0000-4000-8000-000000000010', 'Pipeline', 0);
insert into bots (id, organization_id, section_id, name, slug, position, permission_mode) values
  ('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000011', 'Pipeline bot', 'pipeline-bot', 0, 'auto');
insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values
  ('e7000000-0000-4000-8000-000000000031', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000021', 'Pipeline thread', 'pipeline-session', true),
  ('e7000000-0000-4000-8000-000000000032', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000021', 'Pipeline thread 2', 'pipeline-session-2', false),
  ('e7000000-0000-4000-8000-000000000033', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000021', 'Pipeline thread 3', 'pipeline-session-3', false),
  ('e7000000-0000-4000-8000-000000000034', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000021', 'Pipeline thread 4', 'pipeline-session-4', false),
  ('e7000000-0000-4000-8000-000000000035', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000021', 'Pipeline thread 5', 'pipeline-session-5', false);
insert into runs (id, organization_id, thread_id, bot_id, input, status, lease_owner, lease_expires_at) values
  ('e7000000-0000-4000-8000-000000000041', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000031', 'e7000000-0000-4000-8000-000000000021',
   'Pipeline run', 'running', 'pipeline-worker', now() + interval '5 minutes');

-- The only live worker is the one this file declares.
delete from service_instances where service = 'worker';
insert into service_instances (id, service, process_id, rss_bytes, heap_used_bytes, started_at, heartbeat_at) values
  ('pipeline-worker', 'worker', 1, 0, 0, now(), now());

-- 1. The revision rises on a mode change, not on a rename, and never goes down.
update bots set permission_mode = 'bypass' where id = 'e7000000-0000-4000-8000-000000000021';
update bots set name = 'Pipeline bot renamed' where id = 'e7000000-0000-4000-8000-000000000021';
update bots set permission_revision = 0 where id = 'e7000000-0000-4000-8000-000000000021';
insert into pipeline_proof
  select 1, permission_revision::text from bots where id = 'e7000000-0000-4000-8000-000000000021';

-- 2. Without a staff identity the switch is refused.
set role ohb_api;
do $proof$
begin
  perform staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'v2');
  insert into pipeline_proof values (2, 'leaked');
exception when insufficient_privilege then
  insert into pipeline_proof values (2, 'refused');
end
$proof$;
reset role;

-- 3. A live worker that does not announce v2, then a leased run, hold v2 back.
set role ohb_api;
select set_config('app.staff_user_id', 'e7000000-0000-4000-8000-000000000001', false) \g /dev/null
insert into pipeline_proof
  select 3, status from staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'v2');
reset role;
update service_instances set permission_pipelines = array['legacy', 'v2'] where id = 'pipeline-worker';
set role ohb_api;
insert into pipeline_proof
  select 4, status from staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'v2');
reset role;

-- 5. The run ends: the switch goes through, every bot of the organization
-- moves to a new revision, and a second call changes nothing.
update runs set status = 'completed', lease_owner = null, lease_expires_at = null
 where id = 'e7000000-0000-4000-8000-000000000041';
set role ohb_api;
insert into pipeline_proof
  select 5, status || ':' || previous_pipeline || '>' || current_pipeline
    from staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'v2');
insert into pipeline_proof
  select 6, status from staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'v2');
reset role;
insert into pipeline_proof
  select 7, permission_revision::text from bots where id = 'e7000000-0000-4000-8000-000000000021';

-- 8. In v2 a worker that resolves a gate by policy without the trace fails.
insert into runs (id, organization_id, thread_id, bot_id, input, status) values
  ('e7000000-0000-4000-8000-000000000042', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000032', 'e7000000-0000-4000-8000-000000000021',
   'Pipeline gated run', 'awaiting_approval'),
  ('e7000000-0000-4000-8000-000000000043', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000033', 'e7000000-0000-4000-8000-000000000021',
   'Pipeline human run', 'awaiting_approval'),
  ('e7000000-0000-4000-8000-000000000044', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000034', 'e7000000-0000-4000-8000-000000000021',
   'Pipeline policy run', 'awaiting_approval'),
  ('e7000000-0000-4000-8000-000000000045', 'e7000000-0000-4000-8000-000000000010',
   'e7000000-0000-4000-8000-000000000035', 'e7000000-0000-4000-8000-000000000021',
   'Pipeline legacy run', 'awaiting_approval');
-- One active run per thread and one active gate per run: each gate below
-- has its own run and thread.
set role ohb_worker;
do $proof$
begin
  insert into approval_requests (
    id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at,
    status, selected_choice, resolved_at, resolved_by_policy
  ) values (
    'e7000000-0000-4000-8000-000000000051', 'e7000000-0000-4000-8000-000000000010',
    'e7000000-0000-4000-8000-000000000032', 'e7000000-0000-4000-8000-000000000042', 0,
    'touch notes.md', '["once","deny"]'::jsonb, now() + interval '10 minutes',
    'approved', 'once', now(), 'bypass'
  );
  insert into pipeline_proof values (8, 'leaked');
exception when check_violation then
  insert into pipeline_proof values (8, 'refused');
end
$proof$;

-- 9. A pending gate written without a state belongs to a human.
insert into approval_requests (
  id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at, status
) values (
  'e7000000-0000-4000-8000-000000000052', 'e7000000-0000-4000-8000-000000000010',
  'e7000000-0000-4000-8000-000000000033', 'e7000000-0000-4000-8000-000000000043', 1,
  'rm -rf build', '["once","deny"]'::jsonb, now() + interval '10 minutes', 'pending'
);
insert into pipeline_proof
  select 9, decision_state from approval_requests where id = 'e7000000-0000-4000-8000-000000000052';

-- 10. A traced policy decision is accepted and becomes ready to forward.
insert into approval_requests (
  id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at,
  status, selected_choice, resolved_at, resolved_by_policy,
  decision_state, decision_stage, decided_by_kind, permission_revision_seen, decision_detail
) values (
  'e7000000-0000-4000-8000-000000000053', 'e7000000-0000-4000-8000-000000000010',
  'e7000000-0000-4000-8000-000000000034', 'e7000000-0000-4000-8000-000000000044', 2,
  'touch notes.md', '["once","deny"]'::jsonb, now() + interval '10 minutes',
  'approved', 'once', now(), 'bypass',
  'decided', 'full', 'policy', 2, '{"reason":"full_access"}'::jsonb
);
insert into pipeline_proof
  select 10, forward_state from approval_requests where id = 'e7000000-0000-4000-8000-000000000053';
reset role;

-- 11. Back to legacy: the undelivered policy decision returns to a human,
-- the human gate is untouched, and the revision rises again.
set role ohb_api;
insert into pipeline_proof
  select 11, status || ':' || reverted_gates
    from staff_set_permission_pipeline('e7000000-0000-4000-8000-000000000010', 'legacy');
reset role;
insert into pipeline_proof
  select 12, status || '/' || forward_state || '/' || decision_state || '/' || coalesce(selected_choice, '-')
         || '/' || coalesce(resolved_by_policy, '-')
    from approval_requests where id = 'e7000000-0000-4000-8000-000000000053';
insert into pipeline_proof
  select 13, permission_revision::text from bots where id = 'e7000000-0000-4000-8000-000000000021';

-- 14. In legacy the untraced policy write of today still passes.
set role ohb_worker;
insert into approval_requests (
  id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at,
  status, selected_choice, resolved_at, resolved_by_policy
) values (
  'e7000000-0000-4000-8000-000000000054', 'e7000000-0000-4000-8000-000000000010',
  'e7000000-0000-4000-8000-000000000035', 'e7000000-0000-4000-8000-000000000045', 3,
  'touch notes.md', '["once","deny"]'::jsonb, now() + interval '10 minutes',
  'approved', 'once', now(), 'bypass'
);
insert into pipeline_proof
  select 14, coalesce(decision_state, 'null') from approval_requests where id = 'e7000000-0000-4000-8000-000000000054';
reset role;

select string_agg(value, '|' order by step) from pipeline_proof;
