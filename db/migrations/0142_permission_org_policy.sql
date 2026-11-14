begin;

-- PERM2-8: the organization permission policy of US-PERM2.
--
-- A dedicated table owned by `identity`, not columns on `organizations`:
--   * `organizations` is a hot row written by several contexts (runtime-link
--     among them) and the API may update it under its tenant policy; this
--     policy must only ever be written by an owner or an admin, through
--     `set_organization_permission_policy` below, never by a plain UPDATE;
--   * no row means no policy, which is the safe value the pipeline already
--     uses (no ceiling, no enforced review, no blocklist);
--   * the spec (US_PERMISSIONS section 10) names this table.
--
-- `max_mode` caps every bot of the organization (manual < auto < bypass,
-- `plan` stays permitted); `enforce_review` turns bypass into auto;
-- `rules_mode` says whether the organization's natural-language rules add to
-- or replace a bot's own (stored here, used by PERM2-6 only); and
-- `command_blocklist` holds command prefixes of words refused on a
-- `terminal_danger` gate (iso l'app de référence "team blocklist").

-- One canonical blocklist entry: words of a closed character class separated
-- by single spaces, no shell metacharacter, no quote. The first word is a
-- command name (the matcher compares the basename, after variable
-- assignments and `sudo`): no `/`, no `=`, never `sudo` or `command`.
create or replace function permission_command_blocklist_valid(entries text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select entries is not null
     and coalesce(array_length(entries, 1), 0) <= 50
     and array_position(entries, null) is null
     and (select count(*) = count(distinct e) from unnest(entries) e)
     and not exists (
       select 1 from unnest(entries) e
        where char_length(e) not between 1 and 120
           or e !~ '^[A-Za-z0-9._+-]+( [A-Za-z0-9._/:=,+@%~-]+)*$'
           or split_part(e, ' ', 1) in ('sudo', 'command')
     );
$$;

create table organization_permission_policies (
  organization_id uuid primary key references organizations(id) on delete cascade,
  max_mode text null
    constraint organization_permission_policies_max_mode_check
      check (max_mode is null or max_mode in ('manual', 'auto', 'bypass')),
  enforce_review boolean not null default false,
  rules_mode text not null default 'adds'
    constraint organization_permission_policies_rules_mode_check
      check (rules_mode in ('adds', 'replaces')),
  command_blocklist text[] not null default '{}'
    constraint organization_permission_policies_blocklist_check
      check (permission_command_blocklist_valid(command_blocklist)),
  version bigint not null default 1
    constraint organization_permission_policies_version_check check (version >= 1),
  updated_by_user_id uuid null references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table organization_permission_policies enable row level security;
alter table organization_permission_policies force row level security;
-- The API reads its own tenant (members included) and never writes: every
-- write goes through the definer function, which checks the role.
create policy organization_permission_policies_tenant on organization_permission_policies for select to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- The worker reads the policy of the gate it decides, filtering on
-- `organization_id` explicitly (`readOrganizationPermissionPolicy`).
create policy organization_permission_policies_worker on organization_permission_policies for select to openedbot_worker
  using (true);
grant select on organization_permission_policies to openedbot_api;
grant select on organization_permission_policies to openedbot_worker;
comment on table organization_permission_policies is
  'PERM2-8: ceiling, enforced review, rules mode and command blocklist of an organization. Written only by set_organization_permission_policy (owner or admin); read by the API tenant and the worker pipeline.';

-- Any change raises the revision of every bot of the organization: a policy
-- decision taken before it is redone at the forwarding claim (PERM2-1).
create or replace function organization_permission_policies_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.organization_id;
  return new;
end;
$$;

create trigger organization_permission_policies_revision
after insert or update on organization_permission_policies
for each row execute function organization_permission_policies_revision();

-- The server-side backstop of the ceiling on bot mode writes (every path:
-- PATCH, creation, Marketplace, imports). Raising a mode above the ceiling
-- is refused; lowering one is always allowed, and a bot already above the
-- ceiling stays stored (its effective mode is capped by the pipeline). The
-- application checks first and answers a readable error; this trigger
-- catches a path that forgot to. It takes no lock: a ceiling committed
-- during the write leaves at worst a bot stored above it, which the pipeline
-- caps anyway.
create or replace function bots_permission_ceiling_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ceiling text;
  rank_new integer;
  rank_old integer;
begin
  if tg_op = 'UPDATE' and new.permission_mode is not distinct from old.permission_mode then
    return new;
  end if;
  select p.max_mode into ceiling
    from public.organization_permission_policies p
   where p.organization_id = new.organization_id;
  if ceiling is null then
    return new;
  end if;
  rank_new := case new.permission_mode when 'auto' then 1 when 'bypass' then 2 else 0 end;
  rank_old := case when tg_op = 'UPDATE' then
    case old.permission_mode when 'auto' then 1 when 'bypass' then 2 else 0 end
  else 0 end;
  if rank_new > (case ceiling when 'auto' then 1 when 'bypass' then 2 else 0 end) and rank_new > rank_old then
    raise exception 'permission mode above the organization ceiling'
      using errcode = '42501', hint = 'PERMISSION_MODE_ABOVE_CEILING';
  end if;
  return new;
end;
$$;

create trigger bots_permission_ceiling_guard
before insert or update of permission_mode on bots
for each row execute function bots_permission_ceiling_guard();

-- The one write path. The caller (the API) passes the acting user; the
-- function proves it is a live owner or admin MEMBER of the organization
-- bound to the transaction. An agency acting on a client has no membership
-- there and is refused (D-5). It locks the organization row first, as the
-- pipeline switch does: a gate being decided holds it `for share`, so the
-- write waits for it and every later decision sees the new policy.
-- The policy only exists in a `v2` organization: in `legacy` nothing would
-- enforce it, and saying otherwise would be a lie.
create or replace function set_organization_permission_policy(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_max_mode text,
  p_enforce_review boolean,
  p_rules_mode text,
  p_command_blocklist text[],
  p_expected_version bigint
)
returns table (status text, version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant uuid;
  pipeline text;
  current_version bigint;
  changed boolean;
begin
  begin
    tenant := nullif(current_setting('app.organization_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      tenant := null;
  end;
  if tenant is null or tenant is distinct from p_organization_id then
    raise exception 'organization context mismatch' using errcode = '42501', hint = 'TENANT_MISMATCH';
  end if;
  select o.permission_pipeline into pipeline
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if pipeline is null then
    raise exception 'organization not found' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if p_enforce_review is null or p_rules_mode is null or p_command_blocklist is null then
    raise exception 'incomplete permission policy' using errcode = '22023';
  end if;

  select p.version into current_version
    from public.organization_permission_policies p
   where p.organization_id = p_organization_id
   for update;
  if coalesce(current_version, 0) is distinct from coalesce(p_expected_version, 0) then
    return query select 'conflict'::text, coalesce(current_version, 0);
    return;
  end if;
  if pipeline is distinct from 'v2' then
    return query select 'pipeline_legacy'::text, coalesce(current_version, 0);
    return;
  end if;

  if current_version is null then
    insert into public.organization_permission_policies
      (organization_id, max_mode, enforce_review, rules_mode, command_blocklist, version, updated_by_user_id)
    values (p_organization_id, p_max_mode, p_enforce_review, p_rules_mode, p_command_blocklist, 1, p_actor_user_id);
    return query select 'saved'::text, 1::bigint;
    return;
  end if;

  select p.max_mode is distinct from p_max_mode
      or p.enforce_review is distinct from p_enforce_review
      or p.rules_mode is distinct from p_rules_mode
      or p.command_blocklist is distinct from p_command_blocklist
    into changed
    from public.organization_permission_policies p
   where p.organization_id = p_organization_id;
  if not changed then
    return query select 'unchanged'::text, current_version;
    return;
  end if;
  update public.organization_permission_policies p
     set max_mode = p_max_mode, enforce_review = p_enforce_review, rules_mode = p_rules_mode,
         command_blocklist = p_command_blocklist, version = current_version + 1,
         updated_by_user_id = p_actor_user_id, updated_at = now()
   where p.organization_id = p_organization_id;
  return query select 'saved'::text, current_version + 1;
end;
$$;

comment on function set_organization_permission_policy(uuid, uuid, text, boolean, text, text[], bigint) is
  'PERM2-8: the only write of organization_permission_policies. Requires app.organization_id = p_organization_id and a live owner or admin membership of p_actor_user_id (agencies refused, D-5). Answers saved, unchanged, conflict (stale p_expected_version) or pipeline_legacy.';

revoke all on function set_organization_permission_policy(uuid, uuid, text, boolean, text, text[], bigint) from public;
grant execute on function set_organization_permission_policy(uuid, uuid, text, boolean, text, text[], bigint) to openedbot_api;
revoke all on function bots_permission_ceiling_guard() from public;
revoke all on function organization_permission_policies_revision() from public;

insert into schema_migrations(version) values ('0142_permission_org_policy');
commit;
