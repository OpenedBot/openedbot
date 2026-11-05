begin;

-- Agrégats quotidiens du produit, calculés par le worker à partir des faits
-- `analytics_events` (0032).
--
-- Deux tables, parce qu'elles ne répondent pas à la même question ni à la
-- même contrainte de cycle de vie :
--
--   * `analytics_daily` répond « que fait CETTE organisation » ; c'est une
--     table tenant ordinaire, RLS comprise, qui disparaît avec le tenant.
--   * `analytics_daily_global` répond « que fait le produit » ; elle ne porte
--     aucun identifiant de tenant, donc aucune clé étrangère, donc rien qui
--     l'efface quand un client s'en va.
--
-- Les faits, eux, sont purgés (rétention 90 jours par défaut,
-- `WORKER_ANALYTICS_RETENTION_DAYS`) : ces deux tables sont ce qui reste.

create table analytics_daily (
  day date not null,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  count bigint not null,
  actors bigint not null,
  primary key (day, organization_id, name)
);

comment on table analytics_daily is
  'Agrégat quotidien par organisation (jour × organisation × événement). Table tenant : RLS par app.organization_id, et la cascade de organizations l''efface avec le tenant — c''est voulu, un client supprimé n''a plus de courbe.';
comment on column analytics_daily.count is
  'Nombre d''événements du jour pour ce nom.';
comment on column analytics_daily.actors is
  'Nombre d''acteurs DISTINCTS (analytics_events.actor_id) du jour pour ce nom ; un acteur nul ne compte pas.';

create table analytics_daily_global (
  day date not null,
  name text not null,
  count bigint not null,
  actors bigint not null,
  primary key (day, name)
);

comment on table analytics_daily_global is
  'Agrégat quotidien tous tenants confondus. Volontairement SANS clé étrangère et SANS donnée identifiante (ni organisation, ni acteur) : c''est précisément ce qui permet à l''historique produit de survivre à la suppression d''un tenant. Ne jamais y ajouter de colonne qui désigne un client.';
comment on column analytics_daily_global.actors is
  'Nombre d''acteurs distincts tous tenants confondus ; un acteur actif dans deux organisations n''est compté qu''une fois.';

-- La lecture par plage (`day between ... and ...`, éventuellement filtrée sur
-- `name`) est servie par la clé primaire (day, name) : pas d'index de plus.

alter table analytics_daily enable row level security;
alter table analytics_daily force row level security;

create policy analytics_daily_tenant on analytics_daily to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy analytics_daily_worker on analytics_daily to openedbot_worker using (true) with check (true);

-- `analytics_daily_global` n'est pas une table tenant : il n'existe aucun
-- prédicat de tenant à écrire dessus. Comme `service_instances` (0002), elle
-- reste donc hors RLS et se protège par les seuls droits accordés ; la lecture
-- cross-tenant du backoffice passe par une fonction `security definer` qui
-- vérifie le staff, pas par une politique de ligne.

grant select, insert, update, delete on analytics_daily to openedbot_api;
grant select, insert, update, delete on analytics_daily to openedbot_worker;
grant select on analytics_daily_global to openedbot_api;
grant select, insert, update, delete on analytics_daily_global to openedbot_worker;

insert into schema_migrations(version) values ('0033_analytics_rollups')
on conflict (version) do nothing;

commit;
