begin;

-- Only bounded A2A audit metadata is projected. Prompt/reply summaries and
-- upstream unknown fields are intentionally absent from this schema.
create table runtime_a2a_audit (
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  source text not null default 'a2a_audit',
  source_offset bigint not null,
  source_kind text not null,
  ts double precision not null,
  direction text not null,
  peer text not null,
  task_id text not null,
  captured_at timestamptz not null default now(),
  primary key (organization_id, runtime_id, source, source_offset),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_a2a_audit_source_check check (source = 'a2a_audit'),
  constraint runtime_a2a_audit_offset_check check (source_offset >= 0),
  constraint runtime_a2a_audit_source_kind_check check (source_kind in ('upstream', 'operator.policy_probe')),
  constraint runtime_a2a_audit_timestamp_check check (ts > 0 and ts < 253402300800),
  constraint runtime_a2a_audit_direction_check check (
    (source_kind = 'upstream' and direction in ('inbound', 'outbound', 'push'))
    or (source_kind = 'operator.policy_probe' and direction = 'denied')
  ),
  constraint runtime_a2a_audit_peer_check check (peer ~ '^[A-Za-z0-9][A-Za-z0-9._:@_-]{0,127}$'),
  constraint runtime_a2a_audit_task_check check (task_id ~ '^task-[a-f0-9]{16}$')
);

create index runtime_a2a_audit_page_idx
  on runtime_a2a_audit (organization_id, runtime_id, source, source_offset desc);

comment on table runtime_a2a_audit is
  'Sanitized metadata-only projection of the fixed A2A JSONL audit. Identity is the append-file byte offset; no message summary or raw JSON is stored.';

alter table runtime_a2a_audit enable row level security;
alter table runtime_a2a_audit force row level security;
create policy runtime_a2a_audit_tenant on runtime_a2a_audit to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

revoke all on runtime_a2a_audit from public;
revoke all on runtime_a2a_audit from ohb_worker;
grant select, insert on runtime_a2a_audit to ohb_api;

insert into schema_migrations(version) values ('0096_runtime_a2a_audit');
commit;
