begin;

-- Supprimer une section rapatrie ses bots, ses salons ET ses imports
-- d'équipe vers la section par défaut (`DELETE /api/sections/:id`).
-- `team_imports` n'était accordé qu'en lecture et insertion à ohb_api :
-- l'UPDATE tombait en 42501, et la section qui avait reçu un import ne se
-- supprimait jamais : « Erreur interne » vue en recette le 05-09. Seule la
-- colonne de rangement s'ouvre ; le registre d'import reste immuable.

grant update (section_id) on team_imports to ohb_api;

insert into schema_migrations(version) values ('0049_team_imports_section_reparent')
on conflict (version) do nothing;

commit;
