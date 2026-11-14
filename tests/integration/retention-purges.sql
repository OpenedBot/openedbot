-- Preuve 0169 : purges des codes de connexion et des sessions par le worker.
--
-- Pas d apostrophe isolee dans les commentaires (fichier lu par psql via sh).
--
-- Une ligne, dans cet ordre :
--   1. definition : deux fonctions du role de migration, SECURITY DEFINER,
--      search_path fige, EXECUTE pour openedbot_worker seul ;
--   2. openedbot_worker : les deux tables restent illisibles en direct (42501) ;
--   3. codes      : seul le code expire depuis plus d un jour part ;
--   4. sessions   : seules partent la session web expiree depuis 40 jours et
--      la session native expiree et revoquee depuis plus de 30 jours ; restent
--      la session vivante, celle expiree depuis 10 jours et celle revoquee il
--      y a 40 jours dont le jeton de rafraichissement vaut encore 5 jours ;
--   5. openedbot_api    : appel refuse (42501).
-- Reutilise tenant-a/owner-a crees plus haut dans postgres-rls.sh. Tout se
-- joue dans une transaction annulee : la base sort intacte.
begin;

insert into email_login_codes (id, email, code_hash, expires_at) values
  ('16900000-0000-4000-8000-0000000000c1', 'p0169-old@example.test', 'h1', now() - interval '2 days'),
  ('16900000-0000-4000-8000-0000000000c2', 'p0169-recent@example.test', 'h2', now() - interval '1 hour'),
  ('16900000-0000-4000-8000-0000000000c3', 'p0169-live@example.test', 'h3', now() + interval '10 minutes');

insert into sessions (id, organization_id, user_id, kind, session_token_hash, refresh_token_hash,
                      access_expires_at, refresh_expires_at, revoked_at) values
  ('16900000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031',
   'web', 'p0169-web-dead', null, now() - interval '40 days', null, null),
  ('16900000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031',
   'native', null, 'p0169-native-dead', now() - interval '60 days', now() - interval '35 days', now() - interval '31 days'),
  ('16900000-0000-4000-8000-0000000000a3', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031',
   'web', 'p0169-web-live', null, now() + interval '5 days', null, null),
  ('16900000-0000-4000-8000-0000000000a4', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031',
   'web', 'p0169-web-recent', null, now() - interval '10 days', null, null),
  ('16900000-0000-4000-8000-0000000000a5', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031',
   'native', null, 'p0169-native-rotated', now() - interval '40 days', now() + interval '5 days', now() - interval '40 days');

create temp table retention_proof (step text primary key, outcome text);
grant select, insert, update on retention_proof to openedbot_worker, openedbot_api;

set local role openedbot_worker;
select purge_spent_email_login_codes() \g /dev/null
select purge_dead_sessions() \g /dev/null
do $proof$
begin
  perform count(*) from sessions;
  insert into retention_proof values ('worker_sessions', 'read');
exception when others then
  insert into retention_proof values ('worker_sessions', sqlstate);
end;
$proof$;
do $proof$
begin
  perform count(*) from email_login_codes;
  insert into retention_proof values ('worker_codes', 'read');
exception when others then
  insert into retention_proof values ('worker_codes', sqlstate);
end;
$proof$;
reset role;

set local role openedbot_api;
do $proof$
begin
  perform purge_dead_sessions();
  insert into retention_proof values ('api_call', 'returned');
exception when others then
  insert into retention_proof values ('api_call', sqlstate);
end;
$proof$;
reset role;

insert into retention_proof
  select 'codes_left', string_agg(right(id::text, 2), ',' order by id)
    from email_login_codes where id::text like '16900000-%';
insert into retention_proof
  select 'sessions_left', string_agg(right(id::text, 2), ',' order by id)
    from sessions where id::text like '16900000-%';

select
  (select string_agg(
            pg_get_userbyid(p.proowner) || '/' || p.prosecdef::text
            || '/' || coalesce(array_to_string(p.proconfig, ';'), '-')
            || '/' || exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')::text
            || '/' || has_function_privilege('openedbot_api', p.oid, 'execute')::text
            || '/' || has_function_privilege('openedbot_staff', p.oid, 'execute')::text
            || '/' || has_function_privilege('openedbot_worker', p.oid, 'execute')::text,
            ';' order by p.proname)
     from pg_proc p
    where p.oid in ('public.purge_dead_sessions()'::regprocedure,
                    'public.purge_spent_email_login_codes()'::regprocedure))
  || '|' ||
  (select string_agg(step || '=' || outcome, ',' order by step) from retention_proof);

rollback;
