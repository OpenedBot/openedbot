-- Incidents fournisseur (0046) : cloisonnement tenant, lecture worker sous le
-- tenant du run (0082), cascade a la purge de l organisation.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table incident_proof (own int, other int, worker_scoped int, worker_unscoped int, after_purge int);
insert into incident_proof values (-1, -1, -1, -1, -1);
grant select, insert, update on incident_proof to ohb_api, ohb_worker;

insert into runtimes (
  id, organization_id, name, reachability, link_token_hash, link_last_seen_at, is_active
) values (
  '81000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'Runtime A', 'connector', 'link-hash-inc-a', now(), false
), (
  '81000000-0000-4000-8000-000000000202',
  '20000000-0000-4000-8000-000000000002',
  'Runtime B', 'connector', 'link-hash-inc-b', now(), false
);

insert into runtime_provider_incidents (
  organization_id, runtime_id, provider, kind, until, fallback_provider, fallback_model
) values (
  '10000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000201',
  'openai-codex', 'quota', now() + interval '6 hours', 'opencode-free', 'nemotron'
), (
  '20000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000202',
  'openai-codex', 'auth', now() + interval '24 hours', null, null
);

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update incident_proof set own = (select count(*) from runtime_provider_incidents);
reset role;

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update incident_proof set other = (
  select count(*) from runtime_provider_incidents
   where organization_id = '20000000-0000-4000-8000-000000000002'
);
reset role;

set role ohb_worker;
update incident_proof set worker_scoped = (select count(*) from runtime_provider_incidents);
select set_config('app.organization_id', '', false) \g /dev/null
update incident_proof set worker_unscoped = (select count(*) from runtime_provider_incidents);
reset role;

insert into organizations (id, slug, name) values
  ('11000000-0000-4000-8000-000000000011', 'tenant-inc-purge', 'Tenant Incident Purge');
insert into runtimes (
  id, organization_id, name, reachability, link_token_hash, is_active
) values (
  '81000000-0000-4000-8000-000000000203',
  '11000000-0000-4000-8000-000000000011',
  'Runtime purge', 'connector', 'link-hash-inc-purge', false
);
insert into runtime_provider_incidents (
  organization_id, runtime_id, provider, kind, until
) values (
  '11000000-0000-4000-8000-000000000011',
  '81000000-0000-4000-8000-000000000203',
  'openai-codex', 'quota', now() + interval '6 hours'
);
delete from organizations where id = '11000000-0000-4000-8000-000000000011';
update incident_proof set after_purge = (
  select count(*) from runtime_provider_incidents
   where runtime_id = '81000000-0000-4000-8000-000000000203'
);

select own || '/' || other || '/' || worker_scoped || '/' || worker_unscoped || '/' || after_purge from incident_proof;
