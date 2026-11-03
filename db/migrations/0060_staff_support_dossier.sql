begin;

-- Arbitrage sur les organisations, et dossier support en lecture.
--
-- 1. `staff_list_organizations()` disparaît.
--
-- Une liste d'organisations EST une navigation par organisation, et le
-- backoffice n'en a pas : il est centré sur le compte, l'organisation n'y est
-- qu'un panneau de contexte ouvert depuis une fiche. La route
-- `GET /api/staff/organizations` qui l'appelait part dans le même lot, et
-- aucun autre appelant TypeScript n'existait.
--
-- Pourquoi la supprimer plutôt que la laisser dormir : c'est une fonction
-- `security definer` qui lit TOUTES les organisations, tous tenants
-- confondus, en contournant la RLS, et dont `ohb_api` garde l'EXECUTE. Tant
-- qu'elle existe, il suffit d'une injection ou d'un handler ajouté sans
-- réfléchir pour ramener la base entière dans une réponse HTTP. Une surface
-- cross-tenant qui ne sert plus est une surface d'attaque gratuite : elle se
-- retire avec son dernier appelant, pas « au cas où ».
--
-- `staff_get_organization(uuid)`, elle, RESTE : c'est la primitive du panneau
-- de contexte, elle prend un identifiant déjà connu du staff (il vient de la
-- fiche d'un compte), et `publicOrganizationDetail()` la rabote côté API.
drop function staff_list_organizations();

-- 2. Fonction sœur de `staff_audit_log()`, cadrée sur une organisation ou sur
--    un sujet.
--
-- Le dossier support répond à « pourquoi c'est cassé chez ce client » : il lui
-- faut les dernières lignes d'`audit_log` qui concernent CE compte, pas les
-- 200 dernières lignes de toute la plateforme filtrées après coup côté client
-- (elles ne contiendraient, le plus souvent, aucune ligne du compte demandé).
--
-- Le préambule de garde est celui de `staff_audit_log()` (0035_audit_log.sql),
-- mot pour mot : lecture de `app.staff_user_id`, `invalid_text_representation`
-- capturée, refus `42501` si le staff est absent, refus `42501` si le staff est
-- désactivé, `security definer`, `set search_path = pg_catalog, public`, droits
-- fermés puis rouverts au seul rôle API.
--
-- Rien d'autre n'est élargi. La colonne lue est la vue `audit_log` telle
-- quelle, qui exclut déjà nommément, source par source, les condensats, les
-- enveloppes signées et le matériel de secret (voir le commentaire de la vue).
-- Aucune jointure supplémentaire, aucune colonne de plus, aucune table de
-- messages ni de fils.
--
-- Un sujet se lit dans les DEUX rôles que la vue distingue : `subject_id`
-- (l'assistance staff ouverte SUR ce compte) et `actor_id` (la décision
-- d'approbation prise PAR ce compte). Les deux « concernent le compte » ;
-- n'en garder qu'un rendrait le dossier faux pour la moitié des sources.
--
-- Les deux bornes sont facultatives, mais pas simultanément : sans cadre, la
-- fonction rendrait le journal global, ce qui est exactement le travail de
-- `staff_audit_log()`. Un appel sans cadre est donc une erreur d'appelant, pas
-- un synonyme silencieux.
create function staff_audit_scope(
  p_organization_id uuid default null,
  p_subject_id uuid default null,
  p_limit int default 100,
  p_before timestamptz default null
)
returns table (
  occurred_at timestamptz,
  organization_id uuid,
  source text,
  action text,
  actor_kind text,
  actor_id uuid,
  subject_kind text,
  subject_id uuid,
  details jsonb
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
  if p_organization_id is null and p_subject_id is null then
    raise exception 'staff audit scope required' using errcode = '22023';
  end if;

  return query
    select
      a.occurred_at,
      a.organization_id,
      a.source,
      a.action,
      a.actor_kind,
      a.actor_id,
      a.subject_kind,
      a.subject_id,
      a.details
      from public.audit_log a
     where (p_organization_id is null or a.organization_id = p_organization_id)
       and (
         p_subject_id is null
         or a.subject_id = p_subject_id
         or a.actor_id = p_subject_id
       )
       and (p_before is null or a.occurred_at < p_before)
     order by a.occurred_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

comment on function staff_audit_scope(uuid, uuid, int, timestamptz) is
  'Journal d''audit cadré, servi au dossier support du backoffice staff : les lignes d''`audit_log` d''une organisation, d''un sujet (acteur ou sujet de la ligne), ou des deux. Même préambule de garde que `staff_audit_log()`, même vue source, aucune colonne de plus : ni contenu de message, ni titre de fil, ni jeton, ni condensat. Refuse `22023` sans cadre : le journal global est le travail de `staff_audit_log()`. Pagination par curseur temporel `p_before`, borne plafonnée à 500.';

revoke all on function staff_audit_scope(uuid, uuid, int, timestamptz) from public;
grant execute on function staff_audit_scope(uuid, uuid, int, timestamptz) to ohb_api;

insert into schema_migrations(version) values ('0060_staff_support_dossier')
on conflict (version) do nothing;

commit;
