begin;

-- PERM2-4 (DEV-OHB-254): "Always for this tool on this bot", and the
-- runtime switch "dangerous commands: always allow" (decisions D-3, D-4).
--
-- `bot_permission_grants`: one active grant per (bot, tool_key) at most, no
-- expiry (D-4, iso Grok Bot). Active means `status = 'active'`: no
-- maintenance job, no worker write. A grant only moves `active -> revoked`
-- (trigger); a new grant after a revocation is a new row. Actors carry no
-- key to `memberships`: an agency actor is not a member of its client.
--
-- `runtime_permission_settings`: at most one row per runtime. The terminal
-- switch is the only runtime-wide pre-approval (D-3): a `terminal_danger`
-- gate with the switch on is answered `once`, after the interdictions, the
-- floor and the deletion stage of the pipeline.
--
-- Both tables raise `bots.permission_revision` on every write that can change
-- a decision: the grant's bot, or every bot of the organization for the
-- runtime switch (one active runtime serves the organization, 0013). The
-- worker only reads them, tenant-scoped like the API: its reads set
-- `app.organization_id` to the run's organization and filter on it.

create table bot_permission_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  tool_key text not null
    constraint bot_permission_grants_tool_key_check
      check (tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'),
  status text not null default 'active'
    constraint bot_permission_grants_status_check check (status in ('active', 'revoked')),
  created_by_user_id uuid not null,
  created_by_kind text not null
    constraint bot_permission_grants_created_by_kind_check check (created_by_kind in ('member', 'agency')),
  created_by_agency_organization_id uuid null,
  created_from_approval_id uuid null,
  created_at timestamptz not null default now(),
  revoked_by_user_id uuid null,
  revoked_by_kind text null
    constraint bot_permission_grants_revoked_by_kind_check
      check (revoked_by_kind is null or revoked_by_kind in ('member', 'agency')),
  revoked_reason text null
    constraint bot_permission_grants_revoked_reason_check
      check (revoked_reason is null or char_length(revoked_reason) between 1 and 200),
  revoked_at timestamptz null,
  unique (organization_id, id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, created_from_approval_id)
    references approval_requests(organization_id, id) on delete set null (created_from_approval_id),
  constraint bot_permission_grants_agency_check
    check ((created_by_kind = 'agency') = (created_by_agency_organization_id is not null)),
  constraint bot_permission_grants_revocation_check
    check (
      (status = 'active' and revoked_at is null and revoked_by_user_id is null and revoked_by_kind is null and revoked_reason is null)
      or (status = 'revoked' and revoked_at is not null and revoked_by_user_id is not null and revoked_by_kind is not null)
    )
);

create unique index bot_permission_grants_active_idx
  on bot_permission_grants (organization_id, bot_id, tool_key) where status = 'active';

-- Transitions: `active -> revoked` only, once. Identity and provenance never
-- change; the only other write allowed is the foreign key clearing the gate a
-- grant came from when that gate is purged.
create or replace function bot_permission_grants_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.id, new.organization_id, new.bot_id, new.tool_key, new.created_by_user_id, new.created_by_kind,
      new.created_by_agency_organization_id, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.bot_id, old.tool_key, old.created_by_user_id, old.created_by_kind,
      old.created_by_agency_organization_id, old.created_at) then
    raise exception 'a permission grant is immutable'
      using errcode = '23514', hint = 'PERMISSION_GRANT_IMMUTABLE';
  end if;
  if new.created_from_approval_id is not null and new.created_from_approval_id is distinct from old.created_from_approval_id then
    raise exception 'a permission grant keeps the gate it came from'
      using errcode = '23514', hint = 'PERMISSION_GRANT_IMMUTABLE';
  end if;
  if old.status = 'revoked' and (new.status, new.revoked_at, new.revoked_by_user_id, new.revoked_by_kind, new.revoked_reason)
     is distinct from (old.status, old.revoked_at, old.revoked_by_user_id, old.revoked_by_kind, old.revoked_reason) then
    raise exception 'a revoked permission grant is final'
      using errcode = '23514', hint = 'PERMISSION_GRANT_TRANSITION';
  end if;
  return new;
end;
$$;

create trigger bot_permission_grants_transition
before update on bot_permission_grants
for each row execute function bot_permission_grants_transition();

create or replace function bot_permission_grants_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.bots set permission_revision = permission_revision + 1
   where organization_id = new.organization_id and id = new.bot_id;
  return new;
end;
$$;

create trigger bot_permission_grants_revision_insert
after insert on bot_permission_grants
for each row execute function bot_permission_grants_revision();

create trigger bot_permission_grants_revision_update
after update of status on bot_permission_grants
for each row when (new.status is distinct from old.status)
execute function bot_permission_grants_revision();

alter table bot_permission_grants enable row level security;
alter table bot_permission_grants force row level security;
create policy bot_permission_grants_tenant on bot_permission_grants to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_permission_grants_worker on bot_permission_grants for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update on bot_permission_grants to ohb_api;
grant select on bot_permission_grants to ohb_worker;
comment on table bot_permission_grants is
  'PERM2-4: "Always for this tool on this bot". No expiry; active -> revoked only (trigger); one active row per (bot, tool_key). Read by the worker under its run''s organization.';

create table runtime_permission_settings (
  runtime_id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  terminal_danger_always boolean not null default false,
  updated_by_user_id uuid not null,
  updated_by_kind text not null
    constraint runtime_permission_settings_updated_by_kind_check check (updated_by_kind in ('member', 'agency')),
  updated_by_agency_organization_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_permission_settings_agency_check
    check ((updated_by_kind = 'agency') = (updated_by_agency_organization_id is not null))
);

-- Every bot of the organization takes the switch at its next gate. The bots
-- are locked in id order so two writers never lock them crosswise.
create or replace function runtime_permission_settings_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.bots where organization_id = new.organization_id order by id for update;
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.organization_id;
  return new;
end;
$$;

create trigger runtime_permission_settings_revision_insert
after insert on runtime_permission_settings
for each row execute function runtime_permission_settings_revision();

create trigger runtime_permission_settings_revision_update
after update of terminal_danger_always on runtime_permission_settings
for each row when (new.terminal_danger_always is distinct from old.terminal_danger_always)
execute function runtime_permission_settings_revision();

alter table runtime_permission_settings enable row level security;
alter table runtime_permission_settings force row level security;
create policy runtime_permission_settings_tenant on runtime_permission_settings to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_permission_settings_worker on runtime_permission_settings for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update on runtime_permission_settings to ohb_api;
grant select on runtime_permission_settings to ohb_worker;
comment on table runtime_permission_settings is
  'PERM2-4 (D-3): per runtime, the switch that answers dangerous-command gates once for every bot of the runtime. Read by the worker under its run''s organization.';

insert into schema_migrations(version) values ('0140_permission_grants');
commit;
