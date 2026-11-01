-- DEV-209 (ex OHB-132): the bot manages its own routines from the conversation.
--
-- The tool is `routine_manage`, served by the API as one https MCP server per
-- runtime (`ohb_routines`), installed on the host through the named
-- `mcp_management` verbs. One server per runtime and not per bot: a named
-- profile clones the root config at creation, so a per-bot server would leak
-- to every bot created afterwards. The bot is identified per run instead (a
-- run key signed by the worker, verified by the API), never by the server.
--
-- `secret_hash` is the SHA-256 of the bearer the host sends on every MCP
-- call; the secret itself is shown to nobody and lives only in the host's MCP
-- config. `installed_at` is set only once the host inventory re-reads the
-- server (rule 2 of the release boundary): until then the runner announces
-- nothing to the bot.
--
-- `enabled_bot_ids` lists the bots the operator switched the tool on for, from
-- the bot's Routines pane: the runner gives a run key (and the tool's
-- instructions) to those bots only, and the API refuses any other caller.
-- A deleted bot leaves a stale id behind, which grants nothing: it has no run.
--
-- The worker only reads this table, joined into its run context query.
begin;

create table runtime_routine_tools (
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  secret_hash text not null
    constraint runtime_routine_tools_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$'),
  server_name text not null default 'ohb_routines'
    constraint runtime_routine_tools_server_name_check check (server_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  installed_at timestamptz,
  enabled_bot_ids uuid[] not null default '{}',
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, runtime_id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_routine_tools_created_by_membership_fkey
    foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (created_by_user_id)
);

alter table runtime_routine_tools enable row level security;
alter table runtime_routine_tools force row level security;

create policy runtime_routine_tools_tenant on runtime_routine_tools to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy runtime_routine_tools_worker on runtime_routine_tools for select to ohb_worker using (true);

grant select, insert, update, delete on runtime_routine_tools to ohb_api;
grant select on runtime_routine_tools to ohb_worker;

insert into schema_migrations(version) values ('0105_runtime_routine_tools')
on conflict (version) do nothing;

commit;
