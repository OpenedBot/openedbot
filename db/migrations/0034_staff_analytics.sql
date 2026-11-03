begin;

-- Séries temporelles produit servies au backoffice staff.
--
-- La fonction lit `analytics_daily_global` UNIQUEMENT, jamais `analytics_daily`
-- ni `analytics_events` : `docs/cloud/ADMIN.md` pose que le backoffice n'a pas
-- de navigation par organisation. Servir le détail par tenant ici la
-- réintroduirait par la bande : un écran « analytics » avec une dimension
-- organisation est une navigation par organisation, quel que soit son nom.
--
-- Le préambule de garde est celui de `staff_operational_metrics()`
-- (0023_staff.sql) : mot pour mot, y compris l'exception sur un
-- `app.staff_user_id` illisible.
create or replace function staff_analytics_timeseries(p_from date, p_to date)
returns table (
  day date,
  name text,
  count bigint,
  actors bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query
    select g.day, g.name, g.count, g.actors
      from public.analytics_daily_global g
     where g.day >= p_from
       and g.day <= p_to
     order by g.day asc, g.name asc;
end;
$$;

comment on function staff_analytics_timeseries(date, date) is
  'Séries quotidiennes globales pour le backoffice staff. Agrégat tous tenants confondus : aucune dimension organisation n''est exposée, le backoffice n''ayant pas de navigation par organisation.';

revoke all on function staff_analytics_timeseries(date, date) from public;
grant execute on function staff_analytics_timeseries(date, date) to ohb_api;

insert into schema_migrations(version) values ('0034_staff_analytics')
on conflict (version) do nothing;

commit;
