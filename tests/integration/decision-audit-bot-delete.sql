-- Executed against the disposable integration database after all migrations.
-- The decision is intentionally not cleaned up: the whole database is the
-- disposable boundary and the assertion is precisely that bot deletion keeps
-- this audit row.

insert into organizations (id, slug, name) values
  ('71000000-0000-4000-8000-000000000001', 'decision-audit-a', 'Decision audit A'),
  ('72000000-0000-4000-8000-000000000002', 'decision-audit-b', 'Decision audit B');

insert into sections (id, organization_id, name, position) values
  ('71000000-0000-4000-8000-000000000011', '71000000-0000-4000-8000-000000000001', 'Audit', 0);

insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('71000000-0000-4000-8000-000000000021', '71000000-0000-4000-8000-000000000001',
   '71000000-0000-4000-8000-000000000011', 'Audited bot', 'audited-bot', 'audited-profile', 0);

insert into threads (
  id, organization_id, bot_id, title, hermes_session_id, is_default
) values (
  '71000000-0000-4000-8000-000000000031', '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000021', 'Audited thread', 'audit-session', true
);

insert into runs (id, organization_id, thread_id, bot_id, input, status) values (
  '71000000-0000-4000-8000-000000000041', '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000031', '71000000-0000-4000-8000-000000000021',
  'Run requiring approval', 'completed'
);

insert into approval_requests (
  id, organization_id, thread_id, run_id, command, choices, status,
  selected_choice, forwarded_at, expires_at, resolved_at, decision_id
) values (
  '71000000-0000-4000-8000-000000000051', '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000031', '71000000-0000-4000-8000-000000000041',
  'touch /tmp/audit-proof', '["once","deny"]'::jsonb, 'approved', 'once', now(),
  now() + interval '1 hour', now(), '71000000-0000-4000-8000-000000000061'
);

insert into decisions (
  id, organization_id, thread_id, run_id, approval_request_id, choice,
  envelope, previous_hash, entry_hash, chain_sequence
) values (
  '71000000-0000-4000-8000-000000000061', '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000031', '71000000-0000-4000-8000-000000000041',
  '71000000-0000-4000-8000-000000000051', 'once',
  jsonb_build_object(
    'version', 1,
    'threadId', '71000000-0000-4000-8000-000000000031',
    'runId', '71000000-0000-4000-8000-000000000041',
    'approvalRequestId', '71000000-0000-4000-8000-000000000051'
  ),
  null, 'audit-entry-hash', 1
);

set role ohb_api;
set app.organization_id = '71000000-0000-4000-8000-000000000001';

-- This is the same tenant-scoped DELETE issued by the bot route. It cascades
-- through live thread/run/approval data while the decision stays readable.
delete from bots
 where organization_id = '71000000-0000-4000-8000-000000000001'
   and id = '71000000-0000-4000-8000-000000000021';

select
  (select count(*) from bots where id = '71000000-0000-4000-8000-000000000021') || '/' ||
  (select count(*) from threads where id = '71000000-0000-4000-8000-000000000031') || '/' ||
  (select count(*) from runs where id = '71000000-0000-4000-8000-000000000041') || '/' ||
  (select count(*) from approval_requests where id = '71000000-0000-4000-8000-000000000051') || '/' ||
  (select count(*) from decisions where id = '71000000-0000-4000-8000-000000000061') || '/' ||
  (select count(*) from decisions
    where id = '71000000-0000-4000-8000-000000000061'
      and thread_id is null and run_id is null and approval_request_id is null) || '/' ||
  (select count(*) from decisions
    where id = '71000000-0000-4000-8000-000000000061'
      and envelope->>'threadId' = '71000000-0000-4000-8000-000000000031'
      and envelope->>'runId' = '71000000-0000-4000-8000-000000000041'
      and envelope->>'approvalRequestId' = '71000000-0000-4000-8000-000000000051'
      and entry_hash = 'audit-entry-hash');

set app.organization_id = '72000000-0000-4000-8000-000000000002';
select count(*) from decisions where id = '71000000-0000-4000-8000-000000000061';

reset role;
