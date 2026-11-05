-- openedbot n'ouvre plus de session shell vers l'hôte d'un client :
-- les coordonnées SSH d'un runtime n'ont plus de consommateur, et les garder
-- laisserait en base l'inventaire exact des machines qu'une API compromise
-- saurait joindre. Aucune politique RLS ni vue ne référence ces colonnes.

alter table runtimes drop column if exists ssh_host;
alter table runtimes drop column if exists ssh_port;
alter table runtimes drop column if exists ssh_user;

insert into schema_migrations(version) values ('0022_drop_runtime_ssh')
  on conflict (version) do nothing;
