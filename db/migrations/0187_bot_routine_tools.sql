-- Scheduling from the chat (`routine_manage`, 0105) is on by default.
--
-- 0105 recorded, per runtime, the bots the operator had switched the tool on
-- for (`runtime_routine_tools.enabled_bot_ids`): an absent bot could mean
-- "never chosen" or "switched off", and nothing said why a bot did not have
-- the tool. One row per bot now holds:
--
--   - the operator's choice: `switched_off`, remembered; the API installs the
--     tool on every other bot by itself and never undoes this choice;
--   - what the host proved: `enabled_at` on `runtime_id` (the server enabled
--     on the bot's profile through the host, which copies the server's token
--     into the profile; an entry a profile merely inherited from the root at
--     creation proves nothing), or `disabled_at` for a switched-off bot (the
--     server written off on its profile, inherited entry included);
--   - when a run may rely on it: `ready_at`, after the gateway's MCP reload
--     window, and never while `restart_pending_since` says the gateway still
--     waits for a restart only the operator may trigger;
--   - why the automatic install has not given it yet (`blocked_reason`), and
--     its backoff (`attempts`, `next_attempt_at`).
--
-- Existing choices: every bot listed in `enabled_bot_ids` of an installed
-- runtime keeps the tool with its proven state. A bot that is not listed was
-- never switched on (the switch has never been used in production): it gets
-- the new default, on. The rows of runtime_routine_tools keep the secret and
-- the root install; `enabled_bot_ids` is no longer read nor written.
--
-- `runtime_routine_tools` gains what the API's periodic pass needs: when the
-- host was last verified, a rate-limited mark of refused bearers, and the
-- count of root writes the host could not confirm (automatic root retries
-- stop after a few, until the link reconnects or the operator acts: each root
-- write moves every thread of the organization to a new agent session).
--
-- `runs.user_time_zone`: the IANA zone the person's client sent with the
-- message the run answers (validated by the API), handed to `routine_manage`
-- as the user's zone. NULL for every other run: the bot then asks.
--
-- `routine_tool_due_organizations(n)`: the organizations whose connected host
-- has routine-tool work due, for the API's sweep. SECURITY DEFINER, owned by
-- the migration role: it returns organization ids only.
--
-- The worker reads `bot_routine_tools`, joined into its run context query;
-- the API writes it under the organization's tenant.
begin;

create table bot_routine_tools (
  organization_id uuid not null,
  bot_id uuid not null,
  switched_off boolean not null default false,
  decided_by_user_id uuid,
  decided_at timestamptz,
  runtime_id uuid,
  enabled_at timestamptz,
  disabled_at timestamptz,
  ready_at timestamptz,
  restart_pending_since timestamptz,
  blocked_reason text
    constraint bot_routine_tools_blocked_reason_check check (blocked_reason in (
      'https_required', 'runtime_required', 'host_offline', 'host_unsupported',
      'profile_unsupported', 'host_unreachable', 'unverified'
    )),
  attempts integer not null default 0
    constraint bot_routine_tools_attempts_check check (attempts >= 0),
  next_attempt_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, bot_id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  constraint bot_routine_tools_decided_by_membership_fkey
    foreign key (organization_id, decided_by_user_id)
    references memberships(organization_id, user_id) on delete set null (decided_by_user_id),
  constraint bot_routine_tools_enabled_runtime check ((enabled_at is null and disabled_at is null) or runtime_id is not null),
  constraint bot_routine_tools_one_proof check (enabled_at is null or disabled_at is null)
);

alter table bot_routine_tools enable row level security;
alter table bot_routine_tools force row level security;

create policy bot_routine_tools_tenant on bot_routine_tools to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy bot_routine_tools_worker on bot_routine_tools for select to openedbot_worker using (true);

grant select, insert, update, delete on bot_routine_tools to openedbot_api;
grant select on bot_routine_tools to openedbot_worker;

alter table runtime_routine_tools
  add column verified_at timestamptz,
  add column auth_failed_at timestamptz,
  add column root_failures integer not null default 0
    constraint runtime_routine_tools_root_failures_check check (root_failures >= 0),
  add column root_failed_link_at timestamptz;

alter table runs
  add column user_time_zone text
    constraint runs_user_time_zone_check check (user_time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');

create function public.routine_tool_due_organizations(max_count integer)
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select rt.organization_id
    from public.runtimes rt
   where rt.is_active and rt.revoked_at is null and rt.reachability = 'connector'
     and rt.link_last_seen_at > now() - interval '45 seconds'
     and (
       exists (
         select 1
           from public.bots b
           left join public.bot_profile_provisions p on p.organization_id = b.organization_id and p.bot_id = b.id
           left join public.bot_routine_tools t on t.organization_id = b.organization_id and t.bot_id = b.id
          where b.organization_id = rt.organization_id
            and b.deleted_at is null and b.archived_at is null and b.host_profile_deleting_at is null
            and (p.status is null or p.status = 'succeeded')
            and (t.next_attempt_at is null or t.next_attempt_at <= now())
            and (
              (not coalesce(t.switched_off, false) and (t.enabled_at is null or t.runtime_id is distinct from rt.id))
              or (t.switched_off and b.hermes_profile is not null and (t.disabled_at is null or t.runtime_id is distinct from rt.id))
              or (t.restart_pending_since is not null and t.runtime_id = rt.id)
            )
       )
       or exists (
         select 1 from public.runtime_routine_tools r
          where r.organization_id = rt.organization_id and r.runtime_id = rt.id and r.installed_at is not null
            and (r.verified_at is null or r.verified_at < now() - interval '30 minutes'
              or r.auth_failed_at > coalesce(r.verified_at, '-infinity'::timestamptz))
       )
     )
   order by rt.organization_id
   limit greatest(1, least(max_count, 100))
$$;

do $owner$
declare
  migrator name;
begin
  select t.tableowner into migrator
    from pg_catalog.pg_tables t
   where t.schemaname = 'public' and t.tablename = 'bot_routine_tools';
  if migrator in ('openedbot_api', 'openedbot_worker', 'openedbot_staff') then
    raise exception 'routine_tool_due_organizations: % is an application role, not the migration role', migrator;
  end if;
  execute pg_catalog.format('alter function public.routine_tool_due_organizations(integer) owner to %I', migrator);
end;
$owner$;

revoke all on function public.routine_tool_due_organizations(integer) from public;
grant execute on function public.routine_tool_due_organizations(integer) to openedbot_api;

insert into bot_routine_tools (organization_id, bot_id, runtime_id, enabled_at, ready_at)
select distinct on (rrt.organization_id, b.id)
       rrt.organization_id, b.id, rrt.runtime_id, rrt.installed_at, rrt.installed_at
  from runtime_routine_tools rrt
  join bots b on b.organization_id = rrt.organization_id and b.id = any(rrt.enabled_bot_ids)
 where rrt.installed_at is not null
 order by rrt.organization_id, b.id, rrt.installed_at desc
on conflict (organization_id, bot_id) do nothing;

insert into schema_migrations(version) values ('0187_bot_routine_tools')
on conflict (version) do nothing;

commit;
