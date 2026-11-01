-- Visibilite des sessions pour l ecran Securite du compte.
--
-- sessions_credential (0001_tenancy_auth.sql) n ouvre que les trois portes
-- *_hash : elle sert a retrouver LA session courante depuis son jeton,
-- jamais a en lister plusieurs. Sous withTenant, un select filtre par
-- organization_id renvoie donc toujours zero ligne, meme pour le
-- proprietaire des sessions. sessions_owner_read et sessions_owner_revoke
-- (0019_session_devices.sql) ajoutent la porte utilisateur, pas tenant : le
-- mot de passe et les sessions sont une propriete de l utilisateur, pas de
-- l organisation courante.
--
-- La preuve verifie les quatre proprietes qui comptent :
--   1. app.organization_id seul, sans app.authenticating_user_id : zero
--      ligne, meme pour le proprietaire de la session ;
--   2. app.authenticating_user_id du proprietaire : une ligne ;
--   3. app.authenticating_user_id d un autre utilisateur : zero ligne ;
--   4. une revocation tentee par cet autre utilisateur ne touche aucune ligne.
--
-- Reutilise les organisations, membres et utilisateurs deja crees plus haut
-- dans postgres-rls.sh (tenant-a/owner-a et tenant-b/owner-b) : cette preuve
-- doit rester cablee AVANT la preuve memoire, qui supprime le tenant A.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table session_proof (by_org int, by_owner int, by_other int, revoked_by_other int);
insert into session_proof values (-1, -1, -1, -1);

insert into sessions (
  id, organization_id, user_id, kind, session_token_hash, access_expires_at
) values (
  '90000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000031', 'web', 'session-proof-hash-a', now() + interval '30 days'
);

grant select, insert, update on session_proof to ohb_api;

-- 1. La porte tenant seule : sessions n a pas de policy organization_id en
--    lecture, cette porte reste fermee.
set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
select set_config('app.authenticating_user_id', '', false) \g /dev/null
update session_proof
   set by_org = (select count(*) from sessions where user_id = '30000000-0000-4000-8000-000000000031');
reset role;

-- 2. Le proprietaire de la session : sa ligne, et seulement la sienne.
set role ohb_api;
select set_config('app.organization_id', '', false) \g /dev/null
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000031', false) \g /dev/null
update session_proof
   set by_owner = (select count(*) from sessions where user_id = '30000000-0000-4000-8000-000000000031');
reset role;

-- 3. Un autre utilisateur, meme membre d un autre tenant : rien.
set role ohb_api;
select set_config('app.authenticating_user_id', '30000000-0000-4000-8000-000000000032', false) \g /dev/null
update session_proof
   set by_other = (select count(*) from sessions where user_id = '30000000-0000-4000-8000-000000000031');
reset role;

-- 4. Le meme autre utilisateur tente une revocation : zero ligne touchee, la
--    session du proprietaire reste vivante.
set role ohb_api;
with attempt as (
  update sessions set revoked_at = now()
   where id = '90000000-0000-4000-8000-000000000091'
  returning 1
)
update session_proof set revoked_by_other = (select count(*) from attempt);
reset role;

select by_org || '/' || by_owner || '/' || by_other || '/' || revoked_by_other from session_proof;
