begin;

-- Registre des instances API pour le routage instance-aware du lien
-- connecteur. Le broker WebSocket reste en mémoire du processus ;
-- cette table dit quelle instance tient le tuyau, et comment les autres la
-- joignent en interne.
--
-- Table d'exploitation, hors RLS tenant : comme `service_instances` (0002)
-- et `analytics_daily_global` (0033), elle ne porte aucun identifiant de
-- client. Un load balancer qui envoie le worker sur la réplique A alors que
-- l'hôte est monté sur B s'appuie sur `runtimes.link_instance_id` joint ici.
-- Aucun prédicat de tenant à écrire : la protection est les grants.

create table api_instances (
  instance_id text primary key,
  internal_url text not null
    constraint api_instances_internal_url_check
      check (char_length(internal_url) between 8 and 2048),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  stopped_at timestamptz
);

comment on table api_instances is
  'Répliques API vivantes. Table d''exploitation hors RLS : instance_id (celui posé dans runtimes.link_instance_id), URL interne joignable par les autres répliques, heartbeat. Une ligne sans heartbeat depuis 60 s, ou avec stopped_at, est morte. openedbot_api écrit, openedbot_worker lit.';
comment on column api_instances.instance_id is
  'Identifiant de processus API, le même que runtimes.link_instance_id.';
comment on column api_instances.internal_url is
  'Origine interne de CETTE réplique (API_INTERNAL_URL), joignable par les autres répliques et par le worker. Pas l''URL publique.';
comment on column api_instances.started_at is
  'Démarrage de cette instance ; reposé à chaque réenregistrement.';
comment on column api_instances.last_seen_at is
  'Dernier heartbeat (toutes les 15 s). Au-delà de 60 s sans signe de vie, l''instance est morte.';
comment on column api_instances.stopped_at is
  'Arrêt propre (SIGINT/SIGTERM, après closeAll 1001 du broker). NULL tant que le processus tourne ou s''il a crashé.';

-- Lecture de l'instance propriétaire d'un lien, sans GUC tenant : le relais
-- interne `/internal/runtime-links/:id/proxy` n'en a pas. SECURITY DEFINER
-- pour traverser la RLS de `runtimes` ; la fonction ne rend QUE des
-- coordonnées d'exploitation, aucun identifiant d'organisation.
create function runtime_link_owner(p_runtime_id uuid)
returns table (
  instance_id text,
  internal_url text,
  instance_live boolean,
  link_last_seen_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.link_instance_id,
    i.internal_url,
    (
      i.instance_id is not null
      and i.stopped_at is null
      and i.last_seen_at > now() - interval '60 seconds'
    ) as instance_live,
    r.link_last_seen_at
    from public.runtimes r
    left join public.api_instances i on i.instance_id = r.link_instance_id
   where r.id = p_runtime_id
     and r.reachability = 'connector'
     and r.revoked_at is null;
$$;

comment on function runtime_link_owner(uuid) is
  'Instance qui tient le lien connecteur de ce runtime, et si elle est vivante (heartbeat < 60 s, pas d''arrêt propre). Traverse la RLS de runtimes : le relais interne n''a pas de tenant. Ne rend aucune donnée d''organisation.';

revoke all on function runtime_link_owner(uuid) from public;
grant execute on function runtime_link_owner(uuid) to openedbot_api;
grant execute on function runtime_link_owner(uuid) to openedbot_worker;

grant select, insert, update, delete on api_instances to openedbot_api;
grant select on api_instances to openedbot_worker;

insert into schema_migrations(version) values ('0040_api_instances')
on conflict (version) do nothing;

commit;
