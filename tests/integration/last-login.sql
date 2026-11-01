-- users.last_login_at, livree par 0075_user_last_login.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. fresh             : aucun remplissage retroactif. Deux comptes crees
--                          sans date les gardent nulles, donc la colonne ne
--                          promet rien sur le passe ;
--   2. api_write         : le chemin d authentification (recordUserLogin)
--                          ecrit la date sous le role ohb_api, par le seul
--                          grant table de 0001. users n est pas sous RLS, il n
--                          y a aucune policy a ouvrir ;
--   3. session_untouched : un compte dont une session VIVANTE porte une
--                          activite recente garde last_login_at nul. La
--                          migration ne deduit rien de sessions.last_seen_at,
--                          qui est une activite et pas une entree ;
--   4. search_signed / search_never : staff_search_users rend la colonne, avec
--                          sa valeur pour le compte vu et null pour l autre ;
--   5. dossier_signed / dossier_never : staff_get_user la rend dans son jsonb,
--                          sous user.lastLoginAt, au meme endroit que tous ses
--                          autres champs de compte.
--
-- La preuve insere son propre espace et ses propres comptes ; elle vient en
-- DERNIER dans postgres-rls.sh pour ne preceder aucun comptage global.

create temp table last_login_proof (
  fresh text,
  api_write text,
  session_untouched text,
  search_signed text,
  search_never text,
  dossier_signed text,
  dossier_never text
);
insert into last_login_proof values (
  'unset', 'unset', 'unset', 'unset', 'unset', 'unset', 'unset'
);

grant select, insert, update on last_login_proof to ohb_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('c0000000-0000-4000-8000-000000000001', 'lastlogin-staff@example.test', 'x', 'Last Login Staff');

insert into organizations (id, slug, name) values
  ('c1000000-0000-4000-8000-000000000001', 'lastlogin-org', 'Last Login Org');

-- signed : une connexion sera datee. never : aucune, mais une session vivante.
insert into users (id, email, password_hash, display_name) values
  ('c2000000-0000-4000-8000-000000000001', 'signed@lastlogin.test', 'hash', 'Signed'),
  ('c2000000-0000-4000-8000-000000000002', 'never@lastlogin.test', 'hash', 'Never');

insert into memberships (organization_id, user_id, role) values
  ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'owner'),
  ('c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'member');

-- Session encore ouverte et active a l instant sur le compte never : c est le
-- piege que la colonne ne doit pas tomber dedans.
insert into sessions (
  id, organization_id, user_id, kind, session_token_hash, access_expires_at, last_seen_at
) values (
  'c3000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002',
  'web', 'lastlogin-never-session-token', now() + interval '1 day', now()
);

-- 1. Aucun remplissage retroactif.
update last_login_proof
   set fresh = (
         select case
                  when count(*) = 2 and count(*) filter (where last_login_at is null) = 2
                    then 'null'
                  else 'filled'
                end
           from users
          where email like '%@lastlogin.test'
       );

set role ohb_api;
select set_config('app.staff_user_id', 'c0000000-0000-4000-8000-000000000001', false) \g /dev/null

-- 2. Ce que fait recordUserLogin, avec le role de l API et rien de plus.
update users
   set last_login_at = timestamptz '2026-05-04 08:09:10+00'
 where id = 'c2000000-0000-4000-8000-000000000001';

update last_login_proof
   set api_write = (
         select case
                  when last_login_at = timestamptz '2026-05-04 08:09:10+00' then 'written'
                  else 'lost'
                end
           from users where id = 'c2000000-0000-4000-8000-000000000001'
       ),
       -- 3. La session vivante du voisin ne fabrique aucune date.
       session_untouched = (
         select case when last_login_at is null then 'null' else 'derived' end
           from users where id = 'c2000000-0000-4000-8000-000000000002'
       );

-- 4. La page du backoffice rend la colonne. to_char en UTC : la sortie ne
-- depend ni du DateStyle ni du TimeZone de la session.
update last_login_proof
   set search_signed = coalesce((
         select to_char(last_login_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
           from staff_search_users('signed@lastlogin.test')
       ), 'none'),
       search_never = coalesce((
         select case when last_login_at is null then 'null' else 'leaked' end
           from staff_search_users('never@lastlogin.test')
       ), 'missing');

-- 5. La fiche support la rend dans son jsonb. La comparaison passe par un cast
-- en timestamptz : le rendu textuel du json depend du DateStyle, sa valeur non.
update last_login_proof
   set dossier_signed = case
         when ((select staff_get_user('c2000000-0000-4000-8000-000000000001'))
                 -> 'user' ->> 'lastLoginAt')::timestamptz
              = timestamptz '2026-05-04 08:09:10+00'
           then 'match'
         else 'mismatch'
       end,
       dossier_never = case
         when ((select staff_get_user('c2000000-0000-4000-8000-000000000002'))
                 -> 'user' -> 'lastLoginAt') = 'null'::jsonb
           then 'null'
         else 'leaked'
       end;

reset role;

select fresh || '|' || api_write || '|' || session_untouched
       || '|' || search_signed || '|' || search_never
       || '|' || dossier_signed || '|' || dossier_never
  from last_login_proof;
