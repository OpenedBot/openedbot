-- 0063 a créé la liste d'attente sans droit, puis 0065 a accordé l'insertion
-- à la route publique. Le backoffice staff doit maintenant lire la liste et
-- retirer une adresse pour une désinscription manuelle ou une demande
-- d'effacement.
--
-- La table reste hors tenant et sans RLS : aucune organisation n'existe au
-- moment de l'inscription. Sa seule protection en lecture est donc la session
-- staff imposée par l'application. La route publique `POST /api/waitlist`
-- conserve son écriture seule (`on conflict do nothing` sans cible et aucun
-- `returning`) : ce nouveau droit ne rouvre rien dans sa réponse.
begin;

grant select, delete on waitlist_signups to openedbot_api;

insert into schema_migrations(version) values ('0066_waitlist_staff_read') on conflict (version) do nothing;

commit;
