begin;

-- Playbooks structurés, distincts de la persona : le flatten BotMRR dans
-- `bots.instructions` empêchait l'export et le déclenchement par trigger.
-- `sections.context` est le brief d'équipe partagé : appartenant à
-- l'opérateur, jamais inscriptible par un bot.

create table playbooks (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  key text not null,
  name text not null,
  summary text not null default '',
  triggers text[] not null default '{}',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, key),
  constraint playbooks_key_length check (length(key) between 1 and 80),
  constraint playbooks_name_length check (length(name) between 1 and 200),
  constraint playbooks_summary_length check (length(summary) <= 2000),
  constraint playbooks_instructions_length check (length(instructions) <= 24000)
);

create table bot_playbooks (
  organization_id uuid not null,
  bot_id uuid not null,
  playbook_id uuid not null,
  primary key (organization_id, bot_id, playbook_id),
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, playbook_id) references playbooks(organization_id, id) on delete cascade
);

alter table playbooks enable row level security;
alter table playbooks force row level security;
alter table bot_playbooks enable row level security;
alter table bot_playbooks force row level security;

create policy playbooks_tenant on playbooks to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy playbooks_worker on playbooks to ohb_worker
  using (true) with check (true);
create policy bot_playbooks_tenant on bot_playbooks to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_playbooks_worker on bot_playbooks to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on playbooks to ohb_api;
grant select, insert, update, delete on playbooks to ohb_worker;
grant select, insert, update, delete on bot_playbooks to ohb_api;
grant select, insert, update, delete on bot_playbooks to ohb_worker;

alter table sections
  add column context text not null default ''
    constraint sections_context_length check (length(context) <= 24000);

insert into schema_migrations(version) values ('0018_playbooks_section_context')
on conflict (version) do nothing;

commit;
