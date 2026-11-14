-- Garde et effets de staff_reset_user_password(), livree par
-- 0071_staff_temporary_password_reset.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. le geste ENTIER : nouveau hachage, drapeau must_change_password leve,
--      et TOUTES les sessions encore ouvertes du compte fermees, avec le motif
--      password_change ;
--   2. le voisin ne bouge pas : la session d un autre compte du meme espace
--      reste ouverte ;
--   3. google_only  : un compte qui n entre que par Google est refuse, et son
--      absence de mot de passe reste une absence ;
--   4. no_organization : un compte sans espace vivant est refuse, et son
--      hachage n est pas remplace ;
--   5. compte inconnu : aucune ligne, donc le 404 de l API ;
--   6. 42501 : sans app.staff_user_id vivant, la fonction refuse, meme avec un
--      hachage valide en main ;
--   7. 22023 : un hachage vide ou trop court est refuse plutot que d etre
--      ecrit, ce qui condamnerait le compte a ne plus jamais se connecter.
--
-- La preuve insere ses propres espaces et comptes ; elle vient en DERNIER dans
-- postgres-rls.sh pour ne precede aucun comptage global.

create temp table password_reset_proof (
  status text,
  hash_changed text,
  must_change text,
  closed int,
  reason text,
  neighbour_open int,
  google_status text,
  google_hash text,
  orphan_status text,
  orphan_hash text,
  unknown_rows int,
  no_guc text,
  short_hash text
);
insert into password_reset_proof values (
  'unset', 'unset', 'unset', -1, 'unset', -1, 'unset', 'unset', 'unset', 'unset', -1, 'unset', 'unset'
);

grant select, insert, update on password_reset_proof to openedbot_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('b0000000-0000-4000-8000-000000000001', 'reset-staff@example.test', 'x', 'Reset Staff');

insert into organizations (id, slug, name) values
  ('b1000000-0000-4000-8000-000000000001', 'reset-live', 'Reset Live'),
  ('b1000000-0000-4000-8000-000000000002', 'reset-dead', 'Reset Dead');
update organizations set deleted_at = now()
 where id = 'b1000000-0000-4000-8000-000000000002';

-- Le compte vise, son voisin de tenant, le compte Google et l orphelin.
insert into users (id, email, password_hash, google_subject, display_name) values
  ('b2000000-0000-4000-8000-000000000001', 'reset-target@example.test', 'old-hash', null, 'Target'),
  ('b2000000-0000-4000-8000-000000000002', 'reset-neighbour@example.test', 'other-hash', null, 'Neighbour'),
  ('b2000000-0000-4000-8000-000000000003', 'reset-google@example.test', null, 'google-subject-1', 'Google'),
  ('b2000000-0000-4000-8000-000000000004', 'reset-orphan@example.test', 'orphan-hash', null, 'Orphan');

insert into memberships (organization_id, user_id, role) values
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'owner'),
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', 'member'),
  ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000003', 'member'),
  -- L orphelin appartient au seul espace supprime : vu de lui, il n a plus rien.
  ('b1000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000004', 'owner');

-- Deux sessions ouvertes sur le compte vise, une deja revoquee (elle ne doit
-- pas etre recomptee), une sur le voisin (elle ne doit pas tomber).
insert into sessions (
  id, organization_id, user_id, kind, session_token_hash, access_expires_at, revoked_at
) values
  ('b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001', 'web', 'reset-session-1', now() + interval '1 day', null),
  ('b3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001', 'web', 'reset-session-2', now() + interval '1 day', null),
  ('b3000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001', 'web', 'reset-session-3', now() + interval '1 day', now()),
  ('b3000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000002', 'web', 'reset-session-4', now() + interval '1 day', null);

set role openedbot_api;
select set_config('app.staff_user_id', 'b0000000-0000-4000-8000-000000000001', false) \g /dev/null

-- 1. Le geste passe : verdict, sessions fermees, hachage et drapeau.
update password_reset_proof
   set status = (
         select status
           from staff_reset_user_password(
             'b2000000-0000-4000-8000-000000000001',
             '$argon2id$v=19$m=65536,t=2,p=1$reset-proof-salt$reset-proof-hash'
           )
       );

-- Les lectures qui suivent passent par le proprietaire des tables : openedbot_api ne
-- peut pas relire sessions hors de ses portes RLS, et ce n est pas le sujet.
reset role;
update password_reset_proof
   set closed = (
         select count(*) from sessions
          where user_id = 'b2000000-0000-4000-8000-000000000001'
            and id in ('b3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002')
            and revoked_at is not null
       ),
       reason = (
         select coalesce(min(revoked_reason), 'none') from sessions
          where id = 'b3000000-0000-4000-8000-000000000001'
       ),
       neighbour_open = (
         select count(*) from sessions
          where user_id = 'b2000000-0000-4000-8000-000000000002' and revoked_at is null
       ),
       hash_changed = (
         select case when password_hash = 'old-hash' then 'kept' else 'replaced' end
           from users where id = 'b2000000-0000-4000-8000-000000000001'
       ),
       must_change = (
         select case when must_change_password then 'raised' else 'down' end
           from users where id = 'b2000000-0000-4000-8000-000000000001'
       );

set role openedbot_api;
-- 3 et 4. Les deux refus, et ce qu ils n ont PAS ecrit.
update password_reset_proof
   set google_status = (
         select status from staff_reset_user_password(
           'b2000000-0000-4000-8000-000000000003',
           '$argon2id$v=19$m=65536,t=2,p=1$reset-proof-salt$reset-proof-hash'
         )
       ),
       orphan_status = (
         select status from staff_reset_user_password(
           'b2000000-0000-4000-8000-000000000004',
           '$argon2id$v=19$m=65536,t=2,p=1$reset-proof-salt$reset-proof-hash'
         )
       ),
       -- 5. Compte inconnu : aucune ligne.
       unknown_rows = (
         select count(*) from staff_reset_user_password(
           'b2000000-0000-4000-8000-00000000000f',
           '$argon2id$v=19$m=65536,t=2,p=1$reset-proof-salt$reset-proof-hash'
         )
       );

-- 7. Un hachage trop court est refuse, pas ecrit.
do $reset$
begin
  perform status from staff_reset_user_password(
    'b2000000-0000-4000-8000-000000000001', 'trop-court'
  );
  update password_reset_proof set short_hash = 'accepted';
exception
  when others then
    update password_reset_proof set short_hash = sqlstate;
end;
$reset$;

-- 6. Sans staff vivant : refus, meme avec un hachage valide.
select set_config('app.staff_user_id', '', false) \g /dev/null
do $reset$
begin
  perform status from staff_reset_user_password(
    'b2000000-0000-4000-8000-000000000002',
    '$argon2id$v=19$m=65536,t=2,p=1$reset-proof-salt$reset-proof-hash'
  );
  update password_reset_proof set no_guc = 'leaked';
exception
  when others then
    update password_reset_proof set no_guc = sqlstate;
end;
$reset$;
reset role;

update password_reset_proof
   set google_hash = (
         select case when password_hash is null then 'none' else 'written' end
           from users where id = 'b2000000-0000-4000-8000-000000000003'
       ),
       orphan_hash = (
         select case when password_hash = 'orphan-hash' then 'kept' else 'replaced' end
           from users where id = 'b2000000-0000-4000-8000-000000000004'
       );

select status || '|' || hash_changed || '|' || must_change || '|' || closed
       || '|' || reason || '|' || neighbour_open || '|' || google_status
       || '|' || google_hash || '|' || orphan_status || '|' || orphan_hash
       || '|' || unknown_rows || '|' || no_guc || '|' || short_hash
  from password_reset_proof;
