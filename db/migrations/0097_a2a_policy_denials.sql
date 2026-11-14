begin;

-- Keep the append-file identity separate from the truthful event origin.
-- A blocked outbound tool call need not have created an upstream task.
alter table runtime_a2a_audit
  drop constraint runtime_a2a_audit_source_check,
  drop constraint runtime_a2a_audit_source_kind_check,
  drop constraint runtime_a2a_audit_direction_check,
  drop constraint runtime_a2a_audit_task_check,
  alter column task_id drop not null;

alter table runtime_a2a_audit
  add constraint runtime_a2a_audit_source_check check (
    (source = 'a2a_audit' and source_kind in ('upstream', 'operator.policy_probe'))
    or (source = 'policy_denials' and source_kind = 'operator.policy_guard')
  ),
  add constraint runtime_a2a_audit_source_kind_check check (
    source_kind in ('upstream', 'operator.policy_probe', 'operator.policy_guard')
  ),
  add constraint runtime_a2a_audit_direction_check check (
    (source_kind = 'upstream' and direction in ('inbound', 'outbound', 'push'))
    or (source_kind in ('operator.policy_probe', 'operator.policy_guard') and direction = 'denied')
  ),
  add constraint runtime_a2a_audit_task_check check (
    (task_id is not null and task_id ~ '^task-[a-f0-9]{16}$')
    or (source_kind = 'operator.policy_guard' and task_id is null)
  );

create index runtime_a2a_audit_time_page_idx
  on runtime_a2a_audit (organization_id, runtime_id, ts desc, source desc, source_offset desc);

comment on table runtime_a2a_audit is
  'Sanitized metadata from two fixed A2A append files. The key includes file and byte offset; task-less policy denials do not invent upstream tasks. No summary, request arguments, token, or raw JSON is stored.';

-- Existing FORCE RLS, tenant policy, API SELECT/INSERT grants and worker
-- revocations from 0096 remain in force.
insert into schema_migrations(version) values ('0097_a2a_policy_denials');
commit;
