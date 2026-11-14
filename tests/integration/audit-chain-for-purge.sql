-- Preuve 0154 : audit_chain_for_purge(org), seule lecture worker de la chaine.
--
-- Pas d apostrophe isolee dans les commentaires (fichier lu par psql via sh).
--
-- Une ligne, dans cet ordre :
--   1. definition : proprietaire du role de migration (BYPASSRLS), SECURITY
--      DEFINER, STABLE, search_path fige a pg_catalog, pg_temp ;
--   2. droits     : aucun EXECUTE pour PUBLIC, openedbot_api ni openedbot_staff ;
--                   EXECUTE pour openedbot_worker ;
--   3. openedbot_worker : org A rend ses deux maillons et rien de B, NULL refuse
--                   (22004), lecture directe de la table refusee (42501) ;
--   4. openedbot_api    : appel refuse (42501).
-- Tout se joue dans une transaction annulee : la base sort intacte.
begin;

insert into organizations (id, slug, name) values
  ('15400000-0000-4000-8000-00000000000a', 'p0154-org-a', 'P0154 A'),
  ('15400000-0000-4000-8000-00000000000b', 'p0154-org-b', 'P0154 B');
insert into audit_chain (organization_id, runtime_id, seq, kind, object_key, payload, payload_sha256, prev_hash, hash) values
  ('15400000-0000-4000-8000-00000000000a', '15400000-0000-4000-8000-0000000000a1', 1, 'runtime_anchor', 'p0154/a/1',
   '{"n": 1}', repeat('a', 64), null, repeat('1', 64)),
  ('15400000-0000-4000-8000-00000000000a', '15400000-0000-4000-8000-0000000000a1', 2, 'audit_verdict', 'p0154/a/2',
   '{"n": 2}', repeat('a', 64), repeat('1', 64), repeat('2', 64)),
  ('15400000-0000-4000-8000-00000000000b', '15400000-0000-4000-8000-0000000000b1', 1, 'runtime_anchor', 'p0154/b/1',
   '{"n": 3}', repeat('b', 64), null, repeat('3', 64));

create temp table purge_fn_proof (step text primary key, outcome text);
grant select, insert, update on purge_fn_proof to openedbot_worker, openedbot_api;

set local role openedbot_worker;
insert into purge_fn_proof
  select 'worker_a', count(*) filter (where organization_id = '15400000-0000-4000-8000-00000000000a')::text
                     || '/' || count(*) filter (where organization_id <> '15400000-0000-4000-8000-00000000000a')::text
    from audit_chain_for_purge('15400000-0000-4000-8000-00000000000a');
do $proof$
begin
  perform * from audit_chain_for_purge(null);
  insert into purge_fn_proof values ('worker_null', 'returned');
exception when others then
  insert into purge_fn_proof values ('worker_null', sqlstate);
end;
$proof$;
do $proof$
begin
  perform count(*) from audit_chain;
  insert into purge_fn_proof values ('worker_table', 'read');
exception when others then
  insert into purge_fn_proof values ('worker_table', sqlstate);
end;
$proof$;
reset role;

set local role openedbot_api;
do $proof$
begin
  perform * from audit_chain_for_purge('15400000-0000-4000-8000-00000000000a');
  insert into purge_fn_proof values ('api_call', 'returned');
exception when others then
  insert into purge_fn_proof values ('api_call', sqlstate);
end;
$proof$;
reset role;

select
  pg_get_userbyid(p.proowner) || '/' || r.rolbypassrls::text || '/' || p.prosecdef::text || '/' || p.provolatile::text
  || '/' || coalesce(array_to_string(p.proconfig, ';'), '-')
  || '|' ||
  exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE')::text
  || '/' || has_function_privilege('openedbot_api', p.oid, 'execute')::text
  || '/' || has_function_privilege('openedbot_staff', p.oid, 'execute')::text
  || '/' || has_function_privilege('openedbot_worker', p.oid, 'execute')::text
  || '|' ||
  (select string_agg(step || '=' || outcome, ',' order by step) from purge_fn_proof)
  from pg_proc p
  join pg_roles r on r.oid = p.proowner
 where p.oid = 'public.audit_chain_for_purge(uuid)'::regprocedure;

rollback;
