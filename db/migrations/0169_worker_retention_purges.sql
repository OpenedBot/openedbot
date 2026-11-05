-- Rétention des données de connexion, purgée par le worker (job
-- `event-retention`) aux délais qu'annonce la politique de confidentialité :
--
--   - un code de connexion par e-mail part un jour après son expiration ;
--   - une session part trente jours après la fin de sa validité (jeton de
--     rafraîchissement pour une session native, cookie pour une session web),
--     et jamais moins de trente jours après sa révocation, pour que la liste
--     des appareils et la détection d'un jeton rejoué gardent leur historique.
--
-- Le worker n'a aucun droit sur ces deux tables (0080 les lui a retirés pour
-- `sessions`, 0115 ne les a jamais donnés pour `email_login_codes`) et n'en
-- reçoit pas : il appelle deux fonctions SECURITY DEFINER, sans argument, qui
-- portent elles-mêmes la borne. Un worker défaillant ne peut donc ni lire une
-- ligne ni avancer la purge sur une session encore valide.
begin;

create or replace function public.purge_spent_email_login_codes()
returns bigint
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
  with deleted as (
    delete from public.email_login_codes
     where expires_at < pg_catalog.now() - interval '1 day'
     returning 1
  )
  select pg_catalog.count(*) from deleted;
$$;

create or replace function public.purge_dead_sessions()
returns bigint
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
  with deleted as (
    delete from public.sessions
     where coalesce(refresh_expires_at, access_expires_at) < pg_catalog.now() - interval '30 days'
       and (revoked_at is null or revoked_at < pg_catalog.now() - interval '30 days')
     returning 1
  )
  select pg_catalog.count(*) from deleted;
$$;

-- Propriétaire : le rôle de migration, qui possède les tables et passe la RLS
-- forcée. Un rôle applicatif ne doit jamais posséder ces fonctions.
do $owner$
declare
  migrator name;
begin
  select t.tableowner into migrator
    from pg_catalog.pg_tables t
   where t.schemaname = 'public' and t.tablename = 'sessions';
  if migrator in ('openedbot_api', 'openedbot_worker', 'openedbot_staff') then
    raise exception 'retention purges: % is an application role, not the migration role', migrator;
  end if;
  execute pg_catalog.format('alter function public.purge_spent_email_login_codes() owner to %I', migrator);
  execute pg_catalog.format('alter function public.purge_dead_sessions() owner to %I', migrator);
end;
$owner$;

revoke all on function public.purge_spent_email_login_codes() from public;
revoke all on function public.purge_dead_sessions() from public;
grant execute on function public.purge_spent_email_login_codes() to openedbot_worker;
grant execute on function public.purge_dead_sessions() to openedbot_worker;

comment on function public.purge_spent_email_login_codes() is
  'Deletes e-mail login codes expired for more than one day; returns the count. openedbot_worker only.';
comment on function public.purge_dead_sessions() is
  'Deletes sessions expired, and if revoked revoked, for more than thirty days; returns the count. openedbot_worker only.';

insert into schema_migrations(version) values ('0169_worker_retention_purges')
on conflict (version) do nothing;

commit;
