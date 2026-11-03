-- Le backoffice peut désormais créer un compte pour une adresse, avec un mot
-- de passe TEMPORAIRE envoyé à cette adresse (`staff-routes.ts`,
-- `POST /api/staff/users`). Deux faits nouveaux en base, et rien d'autre.
--
-- 1. `users.must_change_password` : ce que « temporaire » veut dire pour de
--    bon. L'API pose le drapeau à la création, la PWA renvoie sur l'écran de
--    sécurité tant qu'il est levé, et le changement de mot de passe le baisse
--    dans la MÊME transaction que le nouveau hachage
--    (`account-security-routes.ts`). `false` pour tous les comptes existants :
--    ils ont choisi leur mot de passe eux-mêmes, ou n'en ont pas.
--
-- 2. Le genre d'e-mail qui porte ce mot de passe. La contrainte de genre est
--    la jumelle SQL de `TRANSACTIONAL_EMAIL_KINDS`
--    (`contracts/api/src/email-kinds.ts`) : un genre déposé sans son
--    gabarit part en échec de rendu chez le worker, un genre rendu sans sa
--    contrainte n'entre jamais dans la file. Les deux listes se modifient
--    ensemble, ou pas du tout.
begin;

alter table users
  add column if not exists must_change_password boolean not null default false;

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created'
  ));

insert into schema_migrations(version) values ('0070_staff_provisioned_accounts')
on conflict (version) do nothing;

commit;
