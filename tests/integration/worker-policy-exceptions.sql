-- Les policies ohb_worker en using (true), livrees par 0001 a 0088 et reduites
-- par 0080_worker_least_privilege.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici, sur une seule ligne :
--   1. exceptions : la liste EXACTE des tables ou le worker lit toutes les
--                   organisations. Une policy de plus fait echouer la preuve :
--                   elle doit etre ajoutee ici, en connaissance de cause ;
--   2. revoked    : les dix tables que le worker ne lit jamais (0080, 0082,
--                   0148, 0154 pour audit_chain et audit_worm_orphans)
--                   ne lui accordent plus aucun privilege ni aucune policy.
--                   audit_chain : la purge passe par audit_chain_for_purge(org),
--                   une organisation a la fois (preuve audit-chain-for-purge.sql).

select
  (select string_agg(tablename, ',' order by tablename)
     from pg_policies
    where schemaname = 'public'
      and 'ohb_worker' = any (roles)
      and qual = 'true')
  || '|' ||
  (select count(*)
     from unnest(array['sessions', 'native_auth_codes', 'agency_client_invitations',
                       'decisions', 'runtime_link_dispatches',
                       'message_reactions', 'support_messages',
                       'mobile_connect_tickets', 'audit_chain',
                       'audit_worm_orphans']) as t(name)
    where not has_table_privilege('ohb_worker', 'public.' || t.name, 'select, insert, update, delete')
      and not exists (select from pg_policies p
                       where p.schemaname = 'public' and p.tablename = t.name
                         and 'ohb_worker' = any (p.roles)))::text;
