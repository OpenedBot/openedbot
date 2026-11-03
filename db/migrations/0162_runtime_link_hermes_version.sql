begin;

-- La console signale qu'une version plus récente de Hermes est disponible
-- pour le runtime. Hermes est installé et épinglé par edge-setup : l'hôte
-- annonce la version qu'il fait tourner dans `hello.hermesVersion`, que le
-- gateway lisait sans la garder. Elle s'écrit désormais avec `link_agent`
-- (0055), dans la même mise à jour, après admission seulement.
--
-- Valeur brute, tronquée à 64 caractères : l'API ne la compare qu'à une
-- version stable X.Y.Z ; une canary, une pré-release ou une valeur illisible
-- ne déclenchent rien. NULL avant la première déclaration, ou quand le
-- dernier `hello` n'en portait pas.
--
-- Les droits SELECT/UPDATE sur runtimes et leurs politiques RLS couvrent déjà
-- la colonne.
alter table runtimes
  add column if not exists link_hermes_version text null
    constraint runtimes_link_hermes_version_length check (char_length(link_hermes_version) <= 64);

comment on column runtimes.link_hermes_version is
  'Hermes version declared in hello by the last admitted link (hello.hermesVersion), raw, at most 64 characters. Informative: it never refuses a session. NULL before the first declaration or when hello carried none.';

insert into schema_migrations(version) values ('0162_runtime_link_hermes_version') on conflict (version) do nothing;
commit;
