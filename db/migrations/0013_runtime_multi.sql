begin;

-- Une organisation pouvait n'avoir qu'un seul runtime Hermes : `organization_id`
-- portait un `unique`, et `PUT /api/runtime` s'appuyait dessus pour son
-- `on conflict (organization_id)`. Brancher un VPS écrasait donc le runtime
-- local, sans moyen de revenir en arrière ni de garder les deux côte à côte.
--
-- On garde N runtimes et on en désigne un actif. Ce n'est PAS une règle
-- applicative : l'index partiel ci-dessous rend « deux runtimes actifs »
-- impossible en base. C'est ce qui autorise le worker à continuer de joindre
-- `runtimes` sans ORDER BY : il n'y a jamais qu'une ligne candidate.
alter table runtimes drop constraint runtimes_organization_id_key;

alter table runtimes add column is_active boolean not null default false;

-- Les lignes existantes sont, par construction, le runtime unique de leur
-- organisation : elles deviennent l'actif. Une ligne révoquée reste inactive.
update runtimes set is_active = true where revoked_at is null;

create unique index runtimes_one_active_per_org
  on runtimes (organization_id) where is_active;

-- Un runtime révoqué ne peut pas rester actif : sinon le worker joindrait une
-- ligne que l'API considère supprimée.
alter table runtimes add constraint runtimes_active_not_revoked
  check (not is_active or revoked_at is null);

insert into schema_migrations(version) values ('0013_runtime_multi')
on conflict (version) do nothing;

commit;
