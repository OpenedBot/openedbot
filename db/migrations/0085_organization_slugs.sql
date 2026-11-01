-- Le slug d'une organisation devient un segment d'URL public : `/o/<slug>/`.
--
-- Jusqu'ici `organizations.slug` était seulement `not null unique`. L'inscription
-- le fabrique déjà en kebab-case (`organizationSlugCandidate`), mais rien ne
-- l'imposait : une base qui a vécu peut porter un slug en capitales, avec des
-- espaces, ou égal à l'UUID de l'organisation (fixtures, reprises manuelles).
-- Ces formes cassent l'URL, ou la font passer pour un identifiant technique.
--
-- La migration réécrit donc chaque slug non conforme, puis pose la contrainte :
--
--   1. la base part du nom (sinon de l'ancien slug), sans accent ni ponctuation,
--      40 caractères au plus, `espace` si rien ne reste ;
--   2. une collision prend la fin de l'UUID de l'organisation (12 caractères),
--      puis un compteur : le résultat est déterministe et toujours unique ;
--   3. un slug déjà conforme n'est jamais touché : les URL existantes restent.
--
-- Rejouable : au second passage aucune ligne n'est non conforme, et la
-- contrainte est reposée à l'identique. Les anciens liens `/o/<uuid>/` (push,
-- e-mail) restent interprétés par la console, qui les réécrit vers le slug.
begin;

do $$
declare
  org record;
  base text;
  candidate text;
  attempt integer;
begin
  for org in
    select id, slug, name from organizations
     where slug !~ '^[a-z0-9][a-z0-9-]{0,62}$'
        or slug ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by created_at, id
  loop
    base := regexp_replace(
      translate(lower(coalesce(nullif(btrim(org.name), ''), org.slug)),
                'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
      '[^a-z0-9]+', '-', 'g');
    base := btrim(left(btrim(base, '-'), 40), '-');
    if base = '' or base ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      base := 'espace';
    end if;
    attempt := 0;
    loop
      candidate := case attempt
        when 0 then base
        when 1 then base || '-' || right(replace(org.id::text, '-', ''), 12)
        else base || '-' || right(replace(org.id::text, '-', ''), 12) || '-' || attempt
      end;
      exit when not exists (select 1 from organizations where slug = candidate and id <> org.id);
      attempt := attempt + 1;
    end loop;
    update organizations set slug = candidate, updated_at = now() where id = org.id;
  end loop;
end $$;

alter table organizations drop constraint if exists organizations_slug_url_segment;
alter table organizations add constraint organizations_slug_url_segment check (
  slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  and slug !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

insert into schema_migrations(version) values ('0085_organization_slugs') on conflict (version) do nothing;

commit;
