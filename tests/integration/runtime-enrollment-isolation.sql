-- Isolation d un enrolement de runtime.
--
-- L enrolement est la seule table que l API touche SANS session : le runtime
-- qui s appaire n a pas de compte. La porte est donc le hash du secret, pose
-- dans app.session_credential_hash. Si cette porte laissait passer autre chose,
-- une organisation pourrait reclamer l enrolement d une autre — et faire
-- enregistrer chez elle un runtime qu elle ne controle pas, ou pire, laisser un
-- tiers deposer un runtime chez la victime.
--
-- La preuve verifie les trois proprietes qui comptent :
--   1. sans le secret et sans lien d organisation, la ligne est INVISIBLE, y
--      compris son existence ;
--   2. avec le hash exact du secret, elle est visible ;
--   3. une fois reclamee par A, elle n est plus visible depuis B.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table enrollment_proof (blind int, by_secret int, foreign_tenant int);
insert into enrollment_proof values (-1, -1, -1);

insert into runtime_enrollments (
  id, secret_hash, endpoint, runtime_name, verification_code, expires_at
) values (
  '70000000-0000-4000-8000-000000000071', 'secret-hash-a',
  'https://hermes-a.example.test', 'Runtime A', 'ABC234', now() + interval '5 minutes'
);

grant select, insert, update on enrollment_proof to openedbot_api;

-- 1. Une session du tenant A, sans le secret : rien.
set role openedbot_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update enrollment_proof set blind = (select count(*) from runtime_enrollments);
reset role;

-- 2. Le runtime, qui presente le secret : sa ligne, et seulement la sienne.
set role openedbot_api;
select set_config('app.organization_id', '', false) \g /dev/null
select set_config('app.session_credential_hash', 'secret-hash-a', false) \g /dev/null
update enrollment_proof set by_secret = (select count(*) from runtime_enrollments);
reset role;

-- La reclamation lie l enrolement au tenant A.
update runtime_enrollments
   set organization_id = '10000000-0000-4000-8000-000000000001', claimed_at = now()
 where id = '70000000-0000-4000-8000-000000000071';

-- 3. Le tenant B, sans le secret : toujours rien, meme apres reclamation.
set role openedbot_api;
select set_config('app.session_credential_hash', '', false) \g /dev/null
select set_config('app.organization_id', '20000000-0000-4000-8000-000000000002', false) \g /dev/null
update enrollment_proof set foreign_tenant = (select count(*) from runtime_enrollments);
reset role;

select blind || '/' || by_secret || '/' || foreign_tenant from enrollment_proof;
