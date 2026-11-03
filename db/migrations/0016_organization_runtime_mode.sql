begin;

-- Le mode runtime (`bundled` / `external`) ne venait que de `OHB_RUNTIME_MODE`,
-- lu une fois au démarrage du serveur. Conséquence : brancher un Hermes distant
-- exigeait d'éditer `.env.local` puis de redémarrer l'API : un geste
-- d'exploitation impossible depuis l'application, et impossible tout court pour
-- une organisation hébergée qui ne possède pas ce fichier.
--
-- Le mode devient une donnée d'organisation, modifiable par un owner/admin
-- depuis `/settings/runtime`. `null` signifie « suivre le défaut du
-- déploiement » : un hôte existant garde exactement le comportement de son
-- environnement tant que personne n'a choisi explicitement.
--
-- La contrainte n'autorise pas `bundled` en production : cette règle reste
-- portée par l'API (`assertRuntimeModeAllowed`), car seule elle connaît
-- `OHB_ENV`. La base borne les valeurs, pas la politique de déploiement.
alter table organizations
  add column runtime_mode text
    constraint organizations_runtime_mode_check
      check (runtime_mode is null or runtime_mode in ('bundled', 'external'));

insert into schema_migrations(version) values ('0016_organization_runtime_mode')
on conflict (version) do nothing;

commit;
