-- L'étape en cours d'un profil de bot qui se prépare, pour l'écran du centre
-- de la console (« {nom} arrive… ») : son espace sur le serveur, ses règles
-- d'approbation, puis ses outils, nommés. Le roster la lit toutes les 0,6 s
-- tant que le bot se prépare. Écrite au mieux par la passe qui tient le bail :
-- une écriture ratée coûte une ligne de journal, jamais le profil. Des noms
-- d'étape et de toolsets seulement, jamais une réponse de l'hôte.
begin;

alter table bot_profile_provisions
  add column if not exists progress jsonb;

comment on column bot_profile_provisions.progress is
  'Step of the running provisioning pass, for the console: {"step": "space" | "rules" | "tools", "tools": [toolset names being enabled]}. Read only while queued or running.';

insert into schema_migrations(version) values ('0164_profile_provision_progress')
on conflict (version) do nothing;

commit;
