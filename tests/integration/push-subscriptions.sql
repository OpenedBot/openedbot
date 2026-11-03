-- Web Push : cloisonnement tenant et cascade a la purge du compte.
--
-- Reutilise tenant-a / owner-a et tenant-b / owner-b deja crees plus haut
-- dans postgres-rls.sh. Ne touche pas ces tenants : un org jetable prouve
-- la cascade. A jouer AVANT la preuve memoire, qui supprime le tenant A.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table push_proof (own int, other int, after_purge int);
insert into push_proof values (-1, -1, -1);
grant select, insert, update on push_proof to ohb_api;

insert into push_subscriptions (
  id, organization_id, user_id, endpoint, p256dh, auth, locale
) values (
  '91000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000031',
  'https://push.example/tenant-a',
  'p256dhKeyValueAAAAAA',
  'authKeyValueAA',
  'fr'
), (
  '91000000-0000-4000-8000-000000000102',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000032',
  'https://push.example/tenant-b',
  'p256dhKeyValueBBBBBB',
  'authKeyValueBB',
  'en'
);

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000031', false) \g /dev/null
update push_proof set own = (select count(*) from push_subscriptions);
reset role;

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000031', false) \g /dev/null
update push_proof set other = (
  select count(*) from push_subscriptions
   where organization_id = '20000000-0000-4000-8000-000000000002'
);
reset role;

insert into organizations (id, slug, name) values
  ('11000000-0000-4000-8000-000000000001', 'tenant-push-purge', 'Tenant Push Purge');
insert into users (id, email) values
  ('31000000-0000-4000-8000-000000000031', 'push-purge@example.test');
insert into memberships (organization_id, user_id, role) values
  ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000031', 'owner');
insert into push_subscriptions (
  id, organization_id, user_id, endpoint, p256dh, auth, locale
) values (
  '91000000-0000-4000-8000-000000000103',
  '11000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000031',
  'https://push.example/tenant-purge',
  'p256dhKeyValueCCCCCC',
  'authKeyValueCC',
  'fr'
);

delete from organizations where id = '11000000-0000-4000-8000-000000000001';
update push_proof set after_purge = (
  select count(*) from push_subscriptions
   where id = '91000000-0000-4000-8000-000000000103'
);

select own || '/' || other || '/' || after_purge from push_proof;
