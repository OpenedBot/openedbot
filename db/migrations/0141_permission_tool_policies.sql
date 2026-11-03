begin;

-- PERM2-5 (DEV-OHB-255): the per-tool policy of a bot, iso Grok Bot.
--
-- One row per (bot, tool key) that does not follow the mode. No row, or
-- `inherit`, follows the mode; a stored value the pipeline does not know
-- asks (`permission-decision.ts`). `block` is enforced twice: the pipeline
-- denies the gate, and the host plugin refuses the call without a gate
-- (`blocked_tools` of the profile policy, proven by re-read).
--
-- The tool key is the plugin's (`write_file`, `mcp:<server>:<tool>`), the
-- grammar of `APPROVAL_POLICY_TOOL_KEY` and `approvalPolicyToolKeyRe`. The
-- actor is kept without a key to `memberships`: a mandated agency operator
-- is not a member of the client organization (spec PERM2-4).
create table bot_permission_tool_policies (
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  tool_key text not null
    constraint bot_permission_tool_policies_tool_key_check
      check (tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'),
  policy text not null
    constraint bot_permission_tool_policies_policy_check
      check (policy in ('inherit', 'always', 'ask', 'block')),
  updated_by_user_id uuid null references users(id) on delete set null,
  updated_by_kind text not null
    constraint bot_permission_tool_policies_actor_kind_check
      check (updated_by_kind in ('member', 'agency')),
  updated_by_agency_organization_id uuid null references organizations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, bot_id, tool_key),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  constraint bot_permission_tool_policies_agency_actor_check
    check ((updated_by_kind = 'agency') = (updated_by_agency_organization_id is not null))
);

alter table bot_permission_tool_policies enable row level security;
alter table bot_permission_tool_policies force row level security;

create policy bot_permission_tool_policies_tenant on bot_permission_tool_policies to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- The worker reads one organization at a time, under the tenant setting it
-- sets for that read (`modules/roster/src/sql/tool-policies.ts`): no
-- `using (true)`, no write.
create policy bot_permission_tool_policies_worker on bot_permission_tool_policies for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on bot_permission_tool_policies to ohb_api;
grant select on bot_permission_tool_policies to ohb_worker;

-- Any write can change a decision: the bot's revision goes up (0138), so a
-- policy decision taken before it is redone at the forwarding claim.
create or replace function bot_permission_tool_policies_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target record;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  update public.bots set permission_revision = permission_revision + 1
   where organization_id = target.organization_id and id = target.bot_id;
  -- A key moved to another bot (never done by the API) bumps both.
  if tg_op = 'UPDATE' and (old.organization_id, old.bot_id) is distinct from (new.organization_id, new.bot_id) then
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = old.organization_id and id = old.bot_id;
  end if;
  return null;
end;
$$;

revoke all on function bot_permission_tool_policies_revision() from public;

create trigger bot_permission_tool_policies_revision
after insert or update or delete on bot_permission_tool_policies
for each row execute function bot_permission_tool_policies_revision();

comment on table bot_permission_tool_policies is
  'PERM2-5: per-tool policy of a bot (inherit, always, ask, block). Written by the API (owner, admin, mandated agency); read by the worker per organization. Every write raises bots.permission_revision.';

insert into schema_migrations(version) values ('0141_permission_tool_policies');
commit;
