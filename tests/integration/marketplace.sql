-- The Marketplace catalogue (0103).
--
-- organization_agent_templates is tenant data: organization A never reads,
-- writes or updates a template of organization B, and nothing is visible
-- without app.organization_id. The worker has no access at all.
-- marketplace_entries is global (no RLS): openedbot_api reads it, and an entry is
-- withdrawn, never deleted.
--
-- Uses the two organizations seeded by the first proof of postgres-rls.sh.
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table marketplace_proof (
  rls text,
  own int,
  other int,
  cross_insert text,
  cross_update int,
  unscoped int,
  worker text,
  entries int,
  entry_delete text
);
insert into marketplace_proof values ('unset', -1, -1, 'unset', -1, -1, 'unset', -1, 'unset');
grant select, insert, update on marketplace_proof to openedbot_api, openedbot_worker;

update marketplace_proof
   set rls = (select case when c.relrowsecurity and c.relforcerowsecurity then 'on' else 'off' end
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'organization_agent_templates');

insert into organization_agent_templates (id, organization_id, slug, title, document) values
  ('60000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000001', 'analyst', 'Analyst A', 'doc'),
  ('60000000-0000-4000-8000-000000000072', '20000000-0000-4000-8000-000000000002', 'analyst', 'Analyst B', 'doc');
insert into marketplace_entries (id, kind, slug, title, document, version, status) values
  ('60000000-0000-4000-8000-000000000073', 'agent_template', 'official-analyst', 'Official analyst', 'doc', '1.0.0', 'published');

set role openedbot_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false);
update marketplace_proof
   set own = (select count(*) from organization_agent_templates),
       other = (select count(*) from organization_agent_templates
                 where organization_id = '20000000-0000-4000-8000-000000000002');
do $proof$
begin
  insert into organization_agent_templates (id, organization_id, slug, title, document)
  values ('60000000-0000-4000-8000-000000000074', '20000000-0000-4000-8000-000000000002', 'intruder', 'Intruder', 'doc');
  update marketplace_proof set cross_insert = 'allowed';
exception
  when insufficient_privilege then
    update marketplace_proof set cross_insert = 'denied';
end;
$proof$;
with changed as (
  update organization_agent_templates set title = 'Hijacked'
   where id = '60000000-0000-4000-8000-000000000072'
  returning 1
)
update marketplace_proof set cross_update = (select count(*) from changed);
select set_config('app.organization_id', '', false);
update marketplace_proof set unscoped = (select count(*) from organization_agent_templates);
update marketplace_proof set entries = (select count(*) from marketplace_entries where slug = 'official-analyst');
do $proof$
begin
  delete from marketplace_entries where slug = 'official-analyst';
  update marketplace_proof set entry_delete = 'allowed';
exception
  when insufficient_privilege then
    update marketplace_proof set entry_delete = 'denied';
end;
$proof$;
reset role;

set role openedbot_worker;
do $proof$
begin
  perform count(*) from organization_agent_templates;
  update marketplace_proof set worker = 'allowed';
exception
  when insufficient_privilege then
    update marketplace_proof set worker = 'denied';
end;
$proof$;
reset role;

select rls || '/' || own || '/' || other || '/' || cross_insert || '/' || cross_update || '/'
       || unscoped || '/' || worker || '/' || entries || '/' || entry_delete
  from marketplace_proof;
