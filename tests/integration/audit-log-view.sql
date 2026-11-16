-- La vue audit_log herite de la RLS de ses sources (security_invoker), expose
-- exactement les neuf colonnes du contrat, ne lit aucune colonne sensible de
-- ses sources et ne convertit aucune ligne entiere (une ligne entiere passee a
-- to_jsonb ou jsonb_build_object porterait toutes les colonnes de sa source).
-- La preuve lit la base migree, pas un fichier : une migration future qui
-- redefinit la vue est controlee elle aussi. Les colonnes lues viennent des
-- dependances de la regle de la vue, et de celles des vues qu elle lit, de
-- proche en proche ; la ligne entiere de leurs arbres de requete (une Var
-- d attribut 0).
with recursive rule as (
  select oid, ev_action from pg_rewrite where ev_class = 'public.audit_log'::regclass
  union
  select v.oid, v.ev_action
    from rule r
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
    join pg_class c on c.oid = d.refobjid and c.relkind in ('v', 'm')
    join pg_rewrite v on v.ev_class = c.oid
), read as (
  select a.attname
    from rule r
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid and d.refobjsubid > 0
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
)
select coalesce((select array_to_string(reloptions, ',') from pg_class where oid = 'public.audit_log'::regclass), '-')
  || '/' || (select string_agg(attname, ',' order by attnum) from pg_attribute
              where attrelid = 'public.audit_log'::regclass and attnum > 0 and not attisdropped)
  || '/' || case
       when exists (select 1 from read where attname ~* '(email|token|password|hash|claim_code|content|envelope|secret)')
         then 'sensitive:' || (select string_agg(distinct attname, ',') from read
                                where attname ~* '(email|token|password|hash|claim_code|content|envelope|secret)')
       when exists (select 1 from rule where ev_action::text ~ ':varattno 0 ') then 'whole-row'
       else 'clean' end;
