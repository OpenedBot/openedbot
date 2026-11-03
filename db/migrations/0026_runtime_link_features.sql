begin;

-- Ce que l'hôte d'un runtime SAIT faire, tel qu'il l'a dit.
--
-- Une version de hermes-setup dotée de l'opérateur local
-- (`hermes-operator.service`) annonce `provider_management` : les routes
-- hôte `/hermes-setup/…` sont servies, et OHB peut déposer un
-- credential fournisseur (clé API, session OAuth) vers cet opérateur, sans
-- SSH ni action sur le VPS. Une version antérieure n'annonce rien :
-- l'interface doit alors renvoyer vers le geste manuel sur l'hôte, et non
-- proposer une action qui échouerait.
--
-- Deux sources, jamais une capacité supposée :
--   - runtime `connector` : la trame `hello.features` du lien
--     (docs/CONNECTOR.md côté hermes-setup), réécrite à chaque connexion
--     (0024 : `link_connected_at`) ;
--   - runtime `direct` : `GET /hermes-setup/capabilities` relu à chaque
--     sonde RÉUSSIE (enregistrement, activation, « Tester ») ; un 404 écrit
--     `{}` (l'hôte a répondu « je ne l'ai pas »), une sonde en échec ne
--     touche pas la colonne.
-- Le nom `link_features` date du premier usage (lien seul) ; il est conservé.
alter table runtimes
  add column link_features text[] not null default '{}';

comment on column runtimes.link_features is
  'Capacités annoncées dans hello.features par le connecteur (ex. provider_management) ; réécrites à chaque connexion, vides pour un runtime direct.';

insert into schema_migrations(version) values ('0026_runtime_link_features')
on conflict (version) do nothing;

commit;
