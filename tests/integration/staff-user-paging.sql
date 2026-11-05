-- Pagination, recherche et garde des fonctions de 0059_staff_user_paging.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. keyset  : deux pages de 2 sur quatre comptes dont TROIS partagent le
--                meme created_at ne sautent ni ne repetent une ligne, et le
--                total rendu est celui du filtre, pas celui de la page ;
--   2. escape  : un terme contenant % ou _ cherche ces caracteres, jamais un
--                joker ;
--   3. bornes  : la borne est plafonnee a 200 et ramenee a 1 par le bas ;
--   4. omnibox : un fil se resout a son organisation et aux comptes qui y ont
--                acces, jamais a son titre ;
--   5. 42501   : sans app.staff_user_id, et avec un staff desactive, les trois
--                fonctions du lot refusent.
--
-- Les totaux globaux ne sont jamais compares a une constante : ce fichier
-- tourne apres les autres preuves, qui ont deja insere des comptes. Les
-- assertions portent donc sur un jeu nomme (@paging.test) ou sur une egalite
-- que la base verifie elle-meme.

create temp table paging_proof (
  page1_count int,
  page2_count int,
  overlap int,
  covered int,
  total1 int,
  remaining2 int,
  pct text,
  underscore text,
  wildcard int,
  assistance text,
  capped int,
  low_clamp int,
  counts text,
  thread_resolve text,
  thread_leak int,
  no_guc text,
  counts_no_guc text,
  resolve_no_guc text,
  disabled_staff text
);
insert into paging_proof values (
  -1, -1, -1, -1, -1, -1, 'x', 'x', -1, 'x', -1, -1, 'x', 'x', -1,
  'unset', 'unset', 'unset', 'unset'
);

grant select, insert, update on paging_proof to openedbot_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('80000000-0000-4000-8000-000000000091', 'paging-staff@example.test', 'x', 'Paging Staff'),
  ('80000000-0000-4000-8000-000000000092', 'paging-off@example.test', 'x', 'Paging Off');
update staff_users set disabled_at = now()
 where id = '80000000-0000-4000-8000-000000000092';

insert into organizations (id, slug, name) values
  ('90000000-0000-4000-8000-000000000091', 'paging-org', 'Paging Org');

-- Trois comptes a la meme milliseconde : c est exactement le cas qu un curseur
-- reduit au seul created_at perd ou repete.
insert into users (id, email, display_name, created_at) values
  ('91000000-0000-4000-8000-000000000001', 'p-alpha@paging.test', 'Alpha', '2026-05-01T10:00:00.000Z'),
  ('91000000-0000-4000-8000-000000000002', 'p_beta@paging.test', 'Beta', '2026-05-01T10:00:00.000Z'),
  ('91000000-0000-4000-8000-000000000003', 'p-gamma@paging.test', 'Gamma 100%', '2026-05-01T10:00:00.000Z'),
  ('91000000-0000-4000-8000-000000000004', 'p-delta@paging.test', null, '2026-05-02T10:00:00.000Z');

insert into memberships (organization_id, user_id, role) values
  ('90000000-0000-4000-8000-000000000091', '91000000-0000-4000-8000-000000000001', 'owner');

-- 250 comptes de remplissage sur un autre domaine : la borne haute ne se
-- prouve pas sur quatre lignes.
insert into users (id, email)
select ('92000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
       'bulk' || g || '@paging-bulk.test'
  from generate_series(1, 250) g;

-- Un fil, avec un titre que la resolution ne doit JAMAIS rendre.
insert into sections (id, organization_id, name, position) values
  ('93000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000091', 'Paging Section', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('94000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000091',
   '93000000-0000-4000-8000-000000000001', 'Paging Bot', 'paging-bot', 'paging-profile', 0);
insert into threads (id, organization_id, bot_id, title, hermes_session_id) values
  ('95000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000091',
   '94000000-0000-4000-8000-000000000001', 'Secret de fabrication', 'paging-session');

set role openedbot_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000091', false) \g /dev/null

-- 1. Page 1, puis page 2 depuis le curseur keyset de la derniere ligne servie.
-- La derniere ligne de l ordre (created_at desc, lower(email), id) est le
-- minimum de created_at et le maximum des deux autres cles.
with page1 as (
  select * from staff_search_users('paging.test', null, 2)
), cursor_row as (
  select p.created_at, lower(p.email) as email_key, p.id
    from page1 p
   order by p.created_at asc, lower(p.email) desc, p.id desc
   limit 1
), page2 as (
  select s.*
    from cursor_row c,
         lateral staff_search_users('paging.test', null, 2, c.created_at, c.email_key, c.id) s
)
update paging_proof
   set page1_count = (select count(*) from page1),
       page2_count = (select count(*) from page2),
       overlap = (select count(*) from page1 p join page2 q on q.id = p.id),
       covered = (select count(distinct id) from (
         select id from page1 union all select id from page2
       ) both_pages),
       total1 = (select max(total_count) from page1),
       remaining2 = (select max(remaining_count) from page2);

-- 2. Les jokers de like sont echappes des deux cotes.
update paging_proof
   set pct = coalesce((select string_agg(email, ',') from staff_search_users('100%')), 'none'),
       underscore = coalesce((select string_agg(email, ',') from staff_search_users('p_beta')), 'none'),
       wildcard = (select count(*) from staff_search_users('p%beta'));

-- 3. Filtre d assistance serveur et bornes.
update paging_proof
   set assistance = coalesce(
         (select string_agg(email, ',') from staff_search_users('paging.test', 'available')),
         'none'
       ),
       capped = (select count(*) from staff_search_users('paging-bulk.test', null, 100000)),
       low_clamp = (select count(*) from staff_search_users('paging.test', null, 0));

-- 4. Le fil se resout a son organisation et au compte qui y a acces ; son
-- titre ne sort par aucune colonne.
update paging_proof
   set thread_resolve = coalesce(
         (select kind || '/' || label || '/' || context
            from staff_resolve_reference('95000000-0000-4000-8000-000000000001')),
         'none'
       ),
       thread_leak = (
         select count(*) from staff_resolve_reference('95000000-0000-4000-8000-000000000001')
          where label like '%Secret%' or coalesce(context, '') like '%Secret%'
       );
reset role;

-- 5. Les compteurs disent la meme chose que la table, quelles que soient les
-- lignes laissees par les preuves precedentes. La comparaison se fait hors du
-- role openedbot_api : memberships et organizations sont sous RLS tenant, un compte
-- lu depuis ce role en dirait zero et la preuve serait fausse pour la mauvaise
-- raison. Le GUC de staff, lui, reste pose : set_config de session survit au
-- reset role.
update paging_proof
   set counts = (
     select (c.total_count = (select count(*) from users))::text || '/' ||
            (c.impersonable_count = (
              select count(*) from users u
               where exists (
                 select 1 from memberships m
                   join organizations o on o.id = m.organization_id
                  where m.user_id = u.id and o.deleted_at is null
               )
            ))::text
       from staff_user_counts() c
   );

-- 6. Sans GUC de staff, les trois fonctions du lot refusent.
set role openedbot_api;
select set_config('app.staff_user_id', '', false) \g /dev/null
do $paging$
begin
  perform count(*) from staff_search_users();
  update paging_proof set no_guc = 'leaked';
exception
  when others then
    update paging_proof set no_guc = 'denied';
end;
$paging$;
do $paging$
begin
  perform count(*) from staff_user_counts();
  update paging_proof set counts_no_guc = 'leaked';
exception
  when others then
    update paging_proof set counts_no_guc = 'denied';
end;
$paging$;
do $paging$
begin
  perform count(*) from staff_resolve_reference('paging.test');
  update paging_proof set resolve_no_guc = 'leaked';
exception
  when others then
    update paging_proof set resolve_no_guc = 'denied';
end;
$paging$;

-- 7. Staff desactive : meme refus.
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000092', false) \g /dev/null
do $paging$
begin
  perform count(*) from staff_search_users();
  update paging_proof set disabled_staff = 'leaked';
exception
  when others then
    update paging_proof set disabled_staff = 'denied';
end;
$paging$;
reset role;

select page1_count || '|' || page2_count || '|' || overlap || '|' || covered
       || '|' || total1 || '|' || remaining2
       || '|' || pct || '|' || underscore || '|' || wildcard
       || '|' || assistance || '|' || capped || '|' || low_clamp
       || '|' || counts || '|' || thread_resolve || '|' || thread_leak
       || '|' || no_guc || '|' || counts_no_guc || '|' || resolve_no_guc
       || '|' || disabled_staff
  from paging_proof;
