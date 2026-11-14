begin;

-- Comment les bots reçoivent leur modèle : le choix devient une donnée, plus une
-- déduction.
--
-- Jusqu'ici « Global : tous les bots » et « Par bot » n'étaient qu'un onglet,
-- ouvert sur la réalité observée (« un bot porte un modèle, donc on est par
-- bot ») et perdu au rechargement. La précédence, elle, était figée : le modèle
-- du bot primait TOUJOURS sur le choix global. Poser un modèle global ne
-- reprenait donc jamais la main sur un bot déjà réglé, et rien à l'écran ne
-- permettait de dire « désormais, tout le monde suit le global ».
--
-- `per_bot` est le défaut parce qu'il EST le comportement d'avant cette
-- migration : chaque bot garde son modèle, le global ne sert qu'à ceux qui n'en
-- ont pas. Une organisation existante ne change donc pas de comportement.
--
-- `global` ne détruit rien : le modèle propre d'un bot reste en base, simplement
-- ignoré tant que ce mode dure. Revenir à `per_bot` le restitue tel quel.
alter table organizations
  add column model_assignment_mode text not null default 'per_bot'
    constraint organizations_model_assignment_mode_check
      check (model_assignment_mode in ('global', 'per_bot'));

insert into schema_migrations(version) values ('0072_organization_model_assignment_mode')
on conflict (version) do nothing;

commit;
