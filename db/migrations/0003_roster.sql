begin;

-- Le roster : sections, bots, salons (bot_groups) et leurs membres, mémoire
-- de bot, routines planifiées et imports de teams Markdown.

create table sections (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  position integer not null,
  collapsed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, position)
);

-- `hermes_profile` est optionnel : renseigné, il est utilisé et vérifié ;
-- absent, le bot parle à la racine du runtime. Deux NULL restent distincts
-- pour l'unicité, donc plusieurs bots sans profil cohabitent.
-- L'autonomie (délégation spontanée vers un autre bot) est opt-in ; le budget
-- de jetons par défaut couvre `maxSteps` × plancher d'entrée Hermes mesuré
-- (~15 000 jetons par appel).
create table bots (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  section_id uuid not null,
  name text not null,
  slug text not null,
  description text,
  instructions text not null default '',
  model text,
  reasoning_effort text,
  hermes_profile text,
  position integer not null,
  pinned boolean not null default false,
  face jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  autonomy_enabled boolean not null default false,
  autonomy_max_depth integer not null default 3,
  autonomy_max_steps integer not null default 8,
  autonomy_max_handoffs integer not null default 4,
  autonomy_timeout_seconds integer not null default 1800,
  autonomy_token_budget bigint not null default 120000,
  voice_id text,
  unique (organization_id, id),
  unique (organization_id, slug),
  unique (organization_id, hermes_profile),
  foreign key (organization_id, section_id) references sections(organization_id, id),
  constraint bots_autonomy_max_depth_check
    check (autonomy_max_depth between 1 and 4),
  constraint bots_autonomy_max_steps_check
    check (autonomy_max_steps between 1 and 12),
  constraint bots_autonomy_max_handoffs_check
    check (autonomy_max_handoffs between 0 and 8),
  constraint bots_autonomy_timeout_check
    check (autonomy_timeout_seconds between 60 and 3600),
  constraint bots_autonomy_token_budget_check
    check (autonomy_token_budget between 1000 and 200000),
  -- Identifiant public de synthèse vocale, jamais une clé fournisseur. Même
  -- forme normalisée que l'API, y compris pour les écritures directes.
  constraint bots_voice_id_normalized_check
    check (
      voice_id is null
      or (
        char_length(voice_id) between 1 and 512
        and voice_id = btrim(voice_id)
      )
    )
);

-- `instructions` : bulletin partagé du salon, injecté à chaque tour, distinct
-- de la persona de chaque bot. `default_responder` désigne qui répond sans
-- mention explicite.
create table bot_groups (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  section_id uuid not null,
  name text not null,
  position integer not null,
  needs_you boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  pinned boolean not null default false,
  instructions text not null default '',
  default_responder jsonb not null default '{"kind":"everyone"}'::jsonb,
  unique (organization_id, id),
  foreign key (organization_id, section_id) references sections(organization_id, id),
  constraint bot_groups_default_responder_shape check (
    default_responder = '{"kind":"everyone"}'::jsonb
    or default_responder = '{"kind":"mentions"}'::jsonb
    or (
      default_responder->>'kind' = 'member'
      and jsonb_typeof(default_responder->'botId') = 'string'
      and length(default_responder->>'botId') > 0
      and default_responder = jsonb_build_object(
        'kind', 'member',
        'botId', default_responder->>'botId'
      )
    )
  )
);

create table group_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  group_id uuid not null,
  bot_id uuid not null,
  position integer not null,
  primary key (organization_id, group_id, bot_id),
  foreign key (organization_id, group_id) references bot_groups(organization_id, id) on delete cascade,
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade
);

-- La mémoire d'un bot, dans NOTRE base : cloisonnée par bot, visible,
-- éditable, et emportée par la purge de l'organisation : le contraire de la
-- mémoire que le runtime tient à part sur la machine du client. `version`
-- est la précondition de PATCH/DELETE : un client périmé ne peut jamais
-- écraser une correction plus récente en silence.
create table bot_memories (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  content text not null,
  -- `bot` = directive `remember:` en fin de réponse ; distinguer la source
  -- permet à l'opérateur de relire ce que son bot s'est raconté tout seul.
  source text not null check (source in ('operator', 'bot')),
  -- Le run qui a écrit la ligne, quand c'est le bot.
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version >= 1),
  last_edited_by_user_id uuid,
  unique (organization_id, id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  constraint bot_memories_last_editor_fk
    foreign key (organization_id, last_edited_by_user_id)
    references memberships(organization_id, user_id)
    on delete set null (last_edited_by_user_id)
);

-- La lecture d'injection prend les plus RÉCENTES d'un bot : c'est cet ordre
-- exact qui est indexé, pas l'insertion.
create index bot_memories_bot_recent_idx
  on bot_memories (organization_id, bot_id, created_at desc, id desc);

-- Routines : une tâche récurrente par bot (cron 5 champs + fuseau), tirée par
-- le worker dans le fil DM du bot. `next_run_at` est la seule horloge.
-- `created_by_user_id` propage son créateur dans workflows.initiator_user_id
-- au moment du tir (notifications) ; NULL = aucune notification.
create table routines (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id uuid not null,
  name text not null,
  schedule text not null,
  timezone text not null default 'UTC',
  message text not null,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid,
  unique (organization_id, id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  constraint routines_created_by_membership_fkey
    foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (created_by_user_id)
);
create index routines_bot_idx on routines (organization_id, bot_id, created_at);
-- Le tick du worker balaie TOUTES les organisations : l'index est global et
-- partiel, comme `runs_queue_idx`.
create index routines_due_idx on routines (next_run_at) where enabled and next_run_at is not null;

-- Registre d'installation des teams Markdown et clé d'idempotence. `result`
-- est la projection publique allowlistée (ids créés + checklist), jamais le
-- Markdown source ni un secret.
create table team_imports (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  source_id text not null,
  source_release text not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  team_name text not null,
  section_id uuid not null,
  result jsonb not null,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, source_id, source_release),
  foreign key (organization_id, section_id) references sections(organization_id, id),
  foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null
);

create index team_imports_created_idx
  on team_imports (organization_id, created_at desc, id desc);

alter table sections enable row level security;
alter table sections force row level security;
alter table bots enable row level security;
alter table bots force row level security;
alter table bot_groups enable row level security;
alter table bot_groups force row level security;
alter table group_members enable row level security;
alter table group_members force row level security;
alter table bot_memories enable row level security;
alter table bot_memories force row level security;
alter table routines enable row level security;
alter table routines force row level security;
alter table team_imports enable row level security;
alter table team_imports force row level security;

create policy sections_tenant on sections to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy sections_worker on sections to ohb_worker using (true) with check (true);

create policy bots_tenant on bots to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bots_worker on bots to ohb_worker using (true) with check (true);

create policy bot_groups_tenant on bot_groups to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_groups_worker on bot_groups to ohb_worker using (true) with check (true);

create policy group_members_tenant on group_members to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy group_members_worker on group_members to ohb_worker using (true) with check (true);

create policy bot_memories_tenant on bot_memories to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_memories_worker on bot_memories to ohb_worker using (true) with check (true);

create policy routines_tenant on routines to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy routines_worker on routines to ohb_worker using (true) with check (true);

create policy team_imports_tenant on team_imports to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on sections, bots, bot_groups, group_members to ohb_api;
grant select, insert, update, delete on sections, bots, bot_groups, group_members to ohb_worker;
grant select, insert, update, delete on bot_memories to ohb_api;
grant select, insert, update, delete on bot_memories to ohb_worker;
grant select, insert, update, delete on routines to ohb_api;
grant select, insert, update, delete on routines to ohb_worker;
grant select, insert on team_imports to ohb_api;

insert into schema_migrations(version) values ('0003_roster')
on conflict (version) do nothing;

commit;
