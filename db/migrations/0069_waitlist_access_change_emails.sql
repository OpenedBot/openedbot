-- Valider une adresse n'est plus le seul geste qui se dit à la personne : le
-- changement de mode et le retrait d'accès s'annoncent aussi
-- (`staff-waitlist-routes.ts`). Une décision d'équipe qui reste muette laisse
-- quelqu'un devant une porte dont l'état a changé sans qu'il le sache.
--
-- La contrainte de genre est la jumelle SQL de `TRANSACTIONAL_EMAIL_KINDS`
-- (`contracts/api/src/email-kinds.ts`) : un genre déposé sans son
-- gabarit part en échec de rendu chez le worker, un genre rendu sans sa
-- contrainte n'entre jamais dans la file. Les deux listes se modifient
-- ensemble, ou pas du tout.
begin;

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked'
  ));

insert into schema_migrations(version) values ('0069_waitlist_access_change_emails')
on conflict (version) do nothing;

commit;
