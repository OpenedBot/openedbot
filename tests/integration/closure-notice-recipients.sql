-- Destinataires de l avis de fermeture (0149_account_closure_notice).
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. tous   : sans borne atteinte, la fonction rend chaque compte de la
--               table, et son total est celui de la table ;
--   2. borne  : une borne de 1 rend une ligne mais le total entier, pour que
--               l appelant sache que la liste est coupee ;
--   3. genre  : email_outbox accepte le genre account_closure_notice ;
--   4. 42501  : sans app.staff_user_id, et avec un staff desactive, refus.
--
-- Les totaux ne sont jamais compares a une constante : d autres preuves ont
-- deja insere des comptes. La base verifie elle-meme chaque egalite.

create temp table closure_proof (
  all_rows text,
  bounded text,
  kind_ok text,
  no_guc text,
  disabled_staff text
);
insert into closure_proof values ('x', 'x', 'x', 'unset', 'unset');
grant select, insert, update on closure_proof to openedbot_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('80000000-0000-4000-8000-0000000000c1', 'closure-staff@example.test', 'x', 'Closure Staff'),
  ('80000000-0000-4000-8000-0000000000c2', 'closure-off@example.test', 'x', 'Closure Off');
update staff_users set disabled_at = now()
 where id = '80000000-0000-4000-8000-0000000000c2';

insert into users (id, email, display_name) values
  ('9c000000-0000-4000-8000-000000000001', 'camille@closure.test', 'Camille Lefevre'),
  ('9c000000-0000-4000-8000-000000000002', 'sacha@closure.test', null);

-- La reference est lue hors du role openedbot_api : users est sous RLS.
create temp table closure_expected as select count(*)::bigint as total from users;
grant select on closure_expected to openedbot_api;

set role openedbot_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-0000000000c1', false) \g /dev/null

-- 1. Tous les comptes, une ligne chacun, le total de la table.
update closure_proof
   set all_rows = (
     select (count(*) = (select total from closure_expected))::text || '/'
            || (count(distinct r.id) = count(*))::text || '/'
            || bool_and(r.total_count = (select total from closure_expected))::text || '/'
            || (count(*) filter (where r.email = 'camille@closure.test' and r.display_name = 'Camille Lefevre'))::text
       from staff_closure_notice_recipients(20000) r
   );

-- 2. Une borne coupe les lignes, jamais le total.
update closure_proof
   set bounded = (
     select count(*)::text || '/' || bool_and(r.total_count = (select total from closure_expected))::text
       from staff_closure_notice_recipients(1) r
   );

-- 4. Sans GUC de staff : refus.
select set_config('app.staff_user_id', '', false) \g /dev/null
do $closure$
begin
  perform count(*) from staff_closure_notice_recipients();
  update closure_proof set no_guc = 'leaked';
exception
  when others then
    update closure_proof set no_guc = 'denied';
end;
$closure$;

-- Staff desactive : meme refus.
select set_config('app.staff_user_id', '80000000-0000-4000-8000-0000000000c2', false) \g /dev/null
do $closure$
begin
  perform count(*) from staff_closure_notice_recipients();
  update closure_proof set disabled_staff = 'leaked';
exception
  when others then
    update closure_proof set disabled_staff = 'denied';
end;
$closure$;
reset role;

-- 3. La contrainte du genre, relue sur la table elle-meme.
insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
values ('9c000000-0000-4000-8000-0000000000f1', 'account_closure_notice',
        'account_closure_notice:proof:9c000000-0000-4000-8000-000000000001',
        'camille@closure.test', 'fr', '{}'::jsonb);
update closure_proof
   set kind_ok = (select kind from email_outbox where id = '9c000000-0000-4000-8000-0000000000f1');
delete from email_outbox where id = '9c000000-0000-4000-8000-0000000000f1';

select all_rows || '|' || bounded || '|' || kind_ok || '|' || no_guc || '|' || disabled_staff
  from closure_proof;
