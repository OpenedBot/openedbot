-- L'API entre dans la file d'e-mails. Jusqu'ici seul le worker y touchait :
-- il est le seul à ENVOYER, et c'est inchangé. Ce qui change, c'est qui
-- DÉPOSE : une inscription à la liste d'attente naît d'une requête HTTP, pas
-- d'une passe de maintenance, et son accusé doit partir dans la transaction
-- qui l'enregistre.
--
-- `ohb_api` obtient l'insertion, et rien d'autre : pas de lecture (la file
-- porte des adresses en clair jusqu'à l'envoi), pas de mise à jour, pas de
-- suppression. Le bail, les tentatives et l'effacement de l'adresse restent
-- au worker.
begin;

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('account_purge_completed', 'provider_quota_reached', 'waitlist_confirmation'));

create policy email_outbox_api on email_outbox
  for insert to ohb_api
  with check (true);

grant insert on email_outbox to ohb_api;

insert into schema_migrations(version) values ('0064_email_outbox_api')
on conflict (version) do nothing;

commit;
