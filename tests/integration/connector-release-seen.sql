-- Annonce de release edge-setup vue (0109) : chaque membre ne lit que ses
-- propres accuses, dans l organisation courante.
--
-- Reutilise tenant-a / owner-a et tenant-b / owner-b deja crees plus haut
-- dans postgres-rls.sh. A jouer AVANT la preuve memoire, qui supprime le
-- tenant A. Pas d apostrophe isolee dans les commentaires.

create temp table release_seen_proof (own int, other_user int, other_tenant int);
insert into release_seen_proof values (-1, -1, -1);
grant select, insert, update on release_seen_proof to ohb_api;

insert into runtime_connector_release_seen (organization_id, user_id, version) values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031', 'v0.5.9'),
  ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000032', 'v0.5.9');

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000031', false) \g /dev/null
update release_seen_proof set own = (select count(*) from runtime_connector_release_seen);
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000032', false) \g /dev/null
update release_seen_proof set other_user = (select count(*) from runtime_connector_release_seen);
select set_config('app.organization_id', '20000000-0000-4000-8000-000000000002', false) \g /dev/null
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000031', false) \g /dev/null
update release_seen_proof set other_tenant = (select count(*) from runtime_connector_release_seen);
reset role;

delete from runtime_connector_release_seen where version = 'v0.5.9';
select own || '/' || other_user || '/' || other_tenant from release_seen_proof;
