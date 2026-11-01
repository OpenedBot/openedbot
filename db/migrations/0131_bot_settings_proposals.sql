-- Bot-initiated setting changes are proposals. The runtime MCP server is
-- separate from routines, while proposal decisions remain operator-only.
begin;

create table runtime_bot_settings_tools (
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  secret_hash text not null
    constraint runtime_bot_settings_tools_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$'),
  server_name text not null default 'ohb_bot_settings'
    constraint runtime_bot_settings_tools_server_name_check check (server_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  installed_at timestamptz,
  enabled_bot_ids uuid[] not null default '{}',
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, runtime_id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_bot_settings_tools_created_by_membership_fkey
    foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (created_by_user_id)
);

alter table runtime_bot_settings_tools enable row level security;
alter table runtime_bot_settings_tools force row level security;

create policy runtime_bot_settings_tools_tenant on runtime_bot_settings_tools to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy runtime_bot_settings_tools_worker on runtime_bot_settings_tools for select to ohb_worker using (true);

grant select, insert, update, delete on runtime_bot_settings_tools to ohb_api;
grant select on runtime_bot_settings_tools to ohb_worker;

create table bot_setting_proposals (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  run_id uuid not null,
  thread_id uuid not null,
  reason text check (reason is null or char_length(reason) <= 500),
  current jsonb not null check (jsonb_typeof(current) = 'object'),
  proposed jsonb not null check (jsonb_typeof(proposed) = 'object'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  base_updated_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected', 'superseded', 'stale')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references runs(organization_id, id) on delete cascade,
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  constraint bot_setting_proposals_resolved_by_membership_fkey
    foreign key (organization_id, resolved_by)
    references memberships(organization_id, user_id) on delete set null (resolved_by)
);

alter table bot_setting_proposals enable row level security;
alter table bot_setting_proposals force row level security;

create policy bot_setting_proposals_tenant on bot_setting_proposals to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on bot_setting_proposals to ohb_api;

create index bot_setting_proposals_pending_bot_idx
  on bot_setting_proposals (organization_id, bot_id) where status = 'pending';
create index bot_setting_proposals_thread_idx
  on bot_setting_proposals (organization_id, thread_id);

insert into schema_migrations(version) values ('0131_bot_settings_proposals')
on conflict (version) do nothing;

commit;
