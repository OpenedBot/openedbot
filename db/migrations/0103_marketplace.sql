-- The console Marketplace catalogue (OHB-127, docs/cloud/MARKETPLACE_ADR.md §3).
--
-- Two tables, because the repository has no pattern for a table that mixes
-- global rows and per-organization rows under RLS:
--
--   marketplace_entries           global, kept by staff, modeled on
--                                 product_features (0084): no RLS, read by
--                                 ohb_api, written by the staff API only and
--                                 re-read as the proof of the write;
--   organization_agent_templates  per organization, modeled on playbooks
--                                 (0018): tenant policy on app.organization_id.
--
-- Neither table stores an installation state: the Marketplace derives it from
-- host re-reads (ADR §5). A template carries capability NAMES only, never a
-- command, a free URL or a secret (ADR §4, §8); the API validates it before
-- any write (`@openedbot/marketplace/domain/template`).
--
-- The worker never reads a template: organization_agent_templates grants it
-- nothing and has no worker policy (least privilege, 0080 and 0082).
begin;

create table marketplace_entries (
  id uuid primary key,
  kind text not null
    constraint marketplace_entries_kind_check check (kind in ('agent_template', 'agent_distribution')),
  slug text not null unique
    constraint marketplace_entries_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title text not null
    constraint marketplace_entries_title_length check (char_length(title) between 1 and 120),
  summary text
    constraint marketplace_entries_summary_length check (summary is null or char_length(summary) <= 500),
  document text
    constraint marketplace_entries_document_size check (document is null or octet_length(document) <= 1000000),
  capabilities jsonb not null default '{"toolsets": [], "mcp": [], "skills": []}'::jsonb
    constraint marketplace_entries_capabilities_object check (jsonb_typeof(capabilities) = 'object'),
  settings jsonb not null default '{}'::jsonb
    constraint marketplace_entries_settings_object check (jsonb_typeof(settings) = 'object'),
  source_url text
    constraint marketplace_entries_source_url_check check (source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 2048)),
  source_sha text
    constraint marketplace_entries_source_sha_check check (source_sha is null or source_sha ~ '^[0-9a-f]{40}$'),
  version text not null
    constraint marketplace_entries_version_length check (char_length(version) between 1 and 40),
  status text not null default 'draft'
    constraint marketplace_entries_status_check check (status in ('draft', 'published', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_staff uuid references staff_users(id) on delete set null,
  constraint marketplace_entries_template_document check (kind <> 'agent_template' or document is not null),
  constraint marketplace_entries_distribution_source check (
    kind <> 'agent_distribution' or (source_url is not null and source_sha is not null)
  )
);

create index marketplace_entries_published_idx on marketplace_entries (kind, title) where status = 'published';

-- Staff writes go through ohb_api (staffMiddleware), like product_features
-- (0086). No delete: an entry is withdrawn, never erased.
grant select, insert, update on marketplace_entries to ohb_api;

create table organization_agent_templates (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  slug text not null
    constraint organization_agent_templates_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title text not null
    constraint organization_agent_templates_title_length check (char_length(title) between 1 and 120),
  summary text
    constraint organization_agent_templates_summary_length check (summary is null or char_length(summary) <= 500),
  document text not null
    constraint organization_agent_templates_document_size check (octet_length(document) <= 1000000),
  capabilities jsonb not null default '{"toolsets": [], "mcp": [], "skills": []}'::jsonb
    constraint organization_agent_templates_capabilities_object check (jsonb_typeof(capabilities) = 'object'),
  settings jsonb not null default '{}'::jsonb
    constraint organization_agent_templates_settings_object check (jsonb_typeof(settings) = 'object'),
  version text not null default '1.0.0'
    constraint organization_agent_templates_version_length check (char_length(version) between 1 and 40),
  source_bot_id uuid,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, slug),
  constraint organization_agent_templates_source_bot_fkey
    foreign key (organization_id, source_bot_id)
    references bots(organization_id, id) on delete set null (source_bot_id),
  constraint organization_agent_templates_created_by_membership_fkey
    foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (created_by_user_id)
);

alter table organization_agent_templates enable row level security;
alter table organization_agent_templates force row level security;

create policy organization_agent_templates_tenant on organization_agent_templates to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on organization_agent_templates to ohb_api;

insert into schema_migrations(version) values ('0103_marketplace')
on conflict (version) do nothing;

commit;
