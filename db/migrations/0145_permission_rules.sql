begin;

-- PERM2-6 (DEV-OHB-256): natural-language permission rules, iso Grok Bot.
--
-- A rule guides the automatic reviewer (PERM2-7) and nothing else: the
-- worker hands it to the reviewer as fenced data. Interdictions, the floor,
-- the deletion stage, `block` and the command blocklist are decided before
-- the reviewer, so no rule can relax them.
--
-- `bot_id` null is a rule of the whole organization; the organization's
-- `rules_mode` (0142) says whether those add to a bot's own rules or replace
-- them. `kind` is `allow` or `ask_first` ("ask first" wins).
--
-- At most 20 rules per (scope, kind): past it an insert is refused
-- (`PERMISSION_RULES_LIMIT`) instead of dropping the oldest without a word as
-- Grok Bot does (`slice(-20)`, operator decision D-4). No duplicate in a
-- scope, case ignored. The text is stored on one line, whitespace collapsed
-- and secrets masked by the API (`modules/roster/src/domain/permission-rule-input.ts`).
--
-- A rule is never edited: it is added or removed, so the API has no UPDATE.
-- Actors carry no key to `memberships`, as for grants (0140): a mandated
-- agency operator is not a member of the client. An organization rule is
-- always a member's, an owner or an admin (D-5, checked again below).
create table bot_permission_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid null,
  kind text not null
    constraint bot_permission_rules_kind_check check (kind in ('allow', 'ask_first')),
  text text not null
    constraint bot_permission_rules_text_check
      check (char_length(text) between 1 and 1000 and text = btrim(text) and text !~ '[[:cntrl:]]'),
  source text not null default 'settings'
    constraint bot_permission_rules_source_check check (source in ('settings')),
  created_by_user_id uuid not null,
  created_by_kind text not null
    constraint bot_permission_rules_created_by_kind_check check (created_by_kind in ('member', 'agency')),
  created_by_agency_organization_id uuid null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  constraint bot_permission_rules_agency_check
    check ((created_by_kind = 'agency') = (created_by_agency_organization_id is not null)),
  constraint bot_permission_rules_organization_actor_check
    check (bot_id is not null or created_by_kind = 'member')
);

create unique index bot_permission_rules_text_idx
  on bot_permission_rules (organization_id, coalesce(bot_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(text));
create index bot_permission_rules_scope_idx on bot_permission_rules (organization_id, bot_id, kind, created_at);

alter table bot_permission_rules enable row level security;
alter table bot_permission_rules force row level security;

create policy bot_permission_rules_tenant on bot_permission_rules to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
-- The worker reads one organization at a time, under the tenant setting it
-- sets for that read (`modules/roster/src/sql/permission-rules.ts`): no
-- `using (true)`, no write.
create policy bot_permission_rules_worker on bot_permission_rules for select to ohb_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, delete on bot_permission_rules to ohb_api;
grant select on bot_permission_rules to ohb_worker;

-- The cap and the organization actor, on every insert path. The count is
-- taken under a transaction lock of its (organization, scope, kind): two
-- concurrent additions cannot both see 19.
create or replace function bot_permission_rules_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  stored integer;
begin
  if new.bot_id is null and not exists (
    select 1 from public.memberships m
     where m.organization_id = new.organization_id and m.user_id = new.created_by_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required for an organization rule'
      using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'bot_permission_rules:' || new.organization_id::text || ':' || coalesce(new.bot_id::text, 'organization') || ':' || new.kind, 0));
  select count(*) into stored
    from public.bot_permission_rules r
   where r.organization_id = new.organization_id
     and r.bot_id is not distinct from new.bot_id
     and r.kind = new.kind;
  if stored >= 20 then
    raise exception 'at most 20 permission rules of this kind in this scope'
      using errcode = '23514', hint = 'PERMISSION_RULES_LIMIT';
  end if;
  return new;
end;
$$;

revoke all on function bot_permission_rules_limit() from public;

create trigger bot_permission_rules_limit
before insert on bot_permission_rules
for each row execute function bot_permission_rules_limit();

-- Any write changes what the reviewer reads: the revision goes up (0138), so
-- a review verdict taken before it is redone at the forwarding claim. A bot
-- rule raises its bot; an organization rule raises every bot of it.
create or replace function bot_permission_rules_revision()
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
  if target.bot_id is null then
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = target.organization_id;
  else
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = target.organization_id and id = target.bot_id;
  end if;
  return null;
end;
$$;

revoke all on function bot_permission_rules_revision() from public;

create trigger bot_permission_rules_revision
after insert or delete on bot_permission_rules
for each row execute function bot_permission_rules_revision();

comment on table bot_permission_rules is
  'PERM2-6: natural-language rules (allow, ask_first) read by the automatic reviewer only; bot_id null is the organization scope. At most 20 per (scope, kind). Written by the API (bot: owner, admin, mandated agency; organization: owner, admin); read by the worker per organization. Every write raises bots.permission_revision.';

insert into schema_migrations(version) values ('0145_permission_rules');
commit;
