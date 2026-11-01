begin;

-- Public DTO snapshots of slow runtime host reads (MCP inventory, model
-- catalog, host profile list, integrations inventory), served while a shared
-- background read replaces them.
--
-- observed_at is when the live read that produced document BEGAN, never when
-- it was saved: a read started before a write describes the host before it.
-- invalidated_at fences writes across every API process: an upsert whose
-- observation began before the last invalidation is refused by the statement
-- itself, so a slow pre-write read can never overwrite the proof read.
create table runtime_read_snapshots (
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  kind text not null check (kind in ('mcp', 'models', 'profiles', 'integrations')),
  document jsonb,
  observed_at timestamptz not null,
  invalidated_at timestamptz,
  primary key (organization_id, runtime_id, kind),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_read_snapshots_document_check check (document is null or jsonb_typeof(document) = 'object'),
  constraint runtime_read_snapshots_tombstone_check check (document is not null or invalidated_at is not null)
);

comment on table runtime_read_snapshots is
  'Public DTO snapshots only, never a raw host body or a secret. A null document is an invalidation tombstone.';

alter table runtime_read_snapshots enable row level security;
alter table runtime_read_snapshots force row level security;
create policy runtime_read_snapshots_tenant on runtime_read_snapshots to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

revoke all on runtime_read_snapshots from public;
revoke all on runtime_read_snapshots from ohb_worker;
grant select, insert, update, delete on runtime_read_snapshots to ohb_api;

insert into schema_migrations(version) values ('0121_runtime_read_snapshots');
commit;
