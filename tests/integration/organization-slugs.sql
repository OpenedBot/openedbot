-- Slugs d organisation, livres comme segments d URL par 0085_organization_slugs.
--
-- Une migration jouee sur une base neuve ne prouve rien : le cas reel est une
-- base qui porte deja des comptes inscrits. La preuve retire la contrainte,
-- pose des slugs historiques non conformes, rejoue 0085 deux fois, puis exige :
--
--   1. capitales et espaces normalises, collision resolue par la fin de l UUID ;
--   2. un slug egal a l UUID remplace par le nom, accents retires ;
--   3. un slug deja conforme conserve tel quel ;
--   4. un slug sans nom ni lettre utilisable normalise depuis l ancien slug ;
--   5. un second slug conforme conserve ;
--   6. la contrainte refuse un slug non conforme puis un slug en forme d UUID ;
--   7. le second rejeu ne change aucun slug.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

alter table organizations drop constraint if exists organizations_slug_url_segment;

insert into organizations (id, slug, name) values
  ('e5000000-0000-4000-8000-000000000001', 'Acme SAS', 'Acme SAS'),
  ('e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000002', 'Client Émilie'),
  ('e5000000-0000-4000-8000-000000000003', 'acme-sas', 'Acme bis'),
  ('e5000000-0000-4000-8000-000000000004', '-Bad_', ''),
  ('e5000000-0000-4000-8000-000000000005', 'slug-ok', 'Slug ok');

\ir ../../db/migrations/0085_organization_slugs.sql

create temp table organization_slugs_before as
  select id, slug from organizations where id::text like 'e5000000-%';

\ir ../../db/migrations/0085_organization_slugs.sql

create temp table organization_slugs_proof (malformed text, uuid_shaped text);
insert into organization_slugs_proof values ('allowed', 'allowed');

do $$
begin
  insert into organizations (id, slug, name) values ('e5000000-0000-4000-8000-000000000006', 'Bad Slug', 'Bad');
exception when check_violation then
  update organization_slugs_proof set malformed = 'refused';
end $$;

do $$
begin
  insert into organizations (id, slug, name)
  values ('e5000000-0000-4000-8000-000000000007', 'e5000000-0000-4000-8000-000000000007', 'Uuid');
exception when check_violation then
  update organization_slugs_proof set uuid_shaped = 'refused';
end $$;

select string_agg(o.slug, '/' order by o.id)
       || '/' || p.malformed || '/' || p.uuid_shaped || '/'
       || case when exists (
            select 1 from organization_slugs_before b join organizations c on c.id = b.id
             where c.slug <> b.slug) then 'changed' else 'stable' end
  from organizations o, organization_slugs_proof p
 where o.id::text like 'e5000000-%'
 group by p.malformed, p.uuid_shaped;
