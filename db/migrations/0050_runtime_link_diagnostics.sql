begin;

create table runtime_link_diagnostics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  event_id uuid not null,
  component text not null check (component in ('link', 'operator')),
  state text not null check (state in ('unavailable', 'recovered')),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  message text not null check (octet_length(message) <= 256),
  stack text check (octet_length(stack) <= 8192),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (runtime_id, event_id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);

create index runtime_link_diagnostics_recent_idx
  on runtime_link_diagnostics (organization_id, runtime_id, received_at desc, id desc);

alter table runtime_link_diagnostics enable row level security;
alter table runtime_link_diagnostics force row level security;
create policy runtime_link_diagnostics_tenant on runtime_link_diagnostics to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert on runtime_link_diagnostics to openedbot_api;

insert into schema_migrations(version) values ('0050_runtime_link_diagnostics') on conflict (version) do nothing;
commit;
