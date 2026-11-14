-- Un compte sans organisation peut ouvrir une session native, comme sa
-- session web depuis 0086 : sinon le desktop restait bloqué sur « terminez la
-- création de votre espace depuis l'application web » (vu le 02-11-2026 après
-- un `make db-reset-keep-users`). Une fois connecté, il passe par l'onboarding
-- de la console dans la fenêtre du desktop, et la création de l'organisation
-- rattache la session native (`attachSessionOrganization`).
--
-- `sessions.organization_id` est déjà nullable (0086). Reste le code
-- d'autorisation : sa clé étrangère composite vers `memberships` exigeait une
-- adhésion. Elle reste en place pour un code AVEC organisation ; sans
-- organisation (MATCH SIMPLE l'ignore), une clé directe vers `users` garde le
-- lien au compte. La policy `native_auth_codes_credential` accepte déjà une
-- ligne insérée sous son propre hachage (`withCredential`).
begin;

alter table native_auth_codes alter column organization_id drop not null;

alter table native_auth_codes
  add constraint native_auth_codes_user_fk foreign key (user_id) references users(id) on delete cascade;

insert into schema_migrations(version) values ('0158_native_auth_codes_without_organization')
on conflict (version) do nothing;

commit;
