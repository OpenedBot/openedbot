begin;

-- Durable execution commands (ADR 0001 S3, section 4.6): a mutation of
-- execution the API records and the worker executes under a lease, never the
-- API process itself. First kind: the on-demand room compaction (DEV-332),
-- whose summary sessions used to run inside the HTTP request, so a closed tab
-- aborted them and two API replicas could each start one.
--
-- One active command per thread and kind (queued or running): a second
-- request finds it instead of opening a concurrent summary. The lease is
-- fenced like a run's (owner, generation and expiry), so a worker whose lease
-- lapsed writes nothing once another took the command over. `attempts`
-- counts claims, and a command is failed once they are spent rather than
-- retried for ever. No secret and no free text: `progress` and `result` hold
-- counters, `error_code` a stable code.
create table execution_commands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('thread.compact')),
  thread_id uuid not null,
  runtime_id uuid not null,
  requested_by_user_id uuid references users(id) on delete set null,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  cancel_requested_at timestamptz,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  -- Work already written by an attempt (a summary pass), recorded in the
  -- transaction that writes it under the lease: a later attempt settles it
  -- instead of judging the thread again.
  progress jsonb,
  -- The summary run an attempt created on the host (`{id, profile}`): a
  -- cancellation stops it even after the attempt's worker handed it back.
  hermes_run jsonb,
  result jsonb,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)),
  check (status <> 'running' or (lease_owner is not null and lease_expires_at is not null)),
  check ((status = 'succeeded') = (result is not null)),
  check ((status in ('failed', 'cancelled')) = (error_code is not null))
);

create unique index execution_commands_active_subject_idx on execution_commands (organization_id, kind, thread_id)
  where status in ('queued', 'running');
create unique index execution_commands_idempotency_idx
  on execution_commands (organization_id, requested_by_user_id, kind, idempotency_key)
  where idempotency_key is not null;
create index execution_commands_claim_idx on execution_commands (created_at, id)
  where status in ('queued', 'running');
create index execution_commands_finished_idx on execution_commands (finished_at)
  where finished_at is not null;

alter table execution_commands enable row level security;
alter table execution_commands force row level security;
create policy execution_commands_tenant on execution_commands to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- The worker claims across organizations, like bot_host_cleanups: a queue of
-- identifiers, counters and codes, no secret.
create policy execution_commands_worker on execution_commands to openedbot_worker using (true) with check (true);
grant select, insert, update on execution_commands to openedbot_api;
grant select, update, delete on execution_commands to openedbot_worker;
comment on table execution_commands is 'Durable execution mutations recorded by the API and executed by the worker under a fenced lease (ADR 0001 S3).';

insert into schema_migrations(version) values ('0176_execution_commands') on conflict (version) do nothing;
commit;
