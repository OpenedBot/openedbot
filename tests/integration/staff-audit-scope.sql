-- Garde et cadrage de staff_audit_scope(), livree par 0060_staff_support_dossier.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Ce qui est prouve ici :
--   1. cadre organisation : une organisation demandee ne rend QUE ses lignes,
--      et zero ligne du tenant voisin ;
--   2. cadre sujet        : un compte rend ses lignes quelle que soit
--      l organisation ou elles ont eu lieu ;
--   3. cadre acteur       : le compte staff qui a AGI se retrouve par la meme
--      borne de sujet, parce que la vue distingue actor_id de subject_id ;
--   4. cadre combine      : organisation ET sujet se croisent, ils ne
--      s additionnent pas ;
--   5. 42501              : sans app.staff_user_id, et avec un staff
--      desactive, la fonction refuse ;
--   6. 22023              : sans aucun cadre, la fonction refuse plutot que de
--      rendre le journal global, qui est le travail de staff_audit_log().
--
-- La source lue est staff_impersonation_claims, dont les identifiants d audit
-- sont volontairement detaches (0029) : aucune organisation ni aucun compte
-- reel n est necessaire, et cette preuve n interfere avec aucune autre.

create temp table audit_scope_proof (
  org_rows int,
  org_leak int,
  subject_rows int,
  both_rows int,
  actor_rows int,
  no_guc text,
  disabled_staff text,
  no_scope text
);
insert into audit_scope_proof values (-1, -1, -1, -1, -1, 'unset', 'unset', 'unset');

grant select, insert, update on audit_scope_proof to openedbot_api;

insert into staff_users (id, email, password_hash, display_name) values
  ('a0000000-0000-4000-8000-000000000001', 'scope-staff@example.test', 'x', 'Scope Staff'),
  ('a0000000-0000-4000-8000-000000000002', 'scope-off@example.test', 'x', 'Scope Off');
update staff_users set disabled_at = now()
 where id = 'a0000000-0000-4000-8000-000000000002';

-- Deux lignes dans le tenant X, une dans le tenant Y. Le compte U1 apparait
-- dans les deux : c est ce qui separe un cadre de sujet d un cadre de tenant.
insert into staff_impersonation_claims (
  id, staff_user_id, organization_id, user_id, claim_token_hash, expires_at, created_at
) values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
   'scope-hash-1', '2026-06-01T10:05:00Z', '2026-06-01T10:00:00Z'),
  ('a3000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002',
   'scope-hash-2', '2026-06-02T10:05:00Z', '2026-06-02T10:00:00Z'),
  ('a3000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001',
   'scope-hash-3', '2026-06-03T10:05:00Z', '2026-06-03T10:00:00Z');

set role openedbot_api;
select set_config('app.staff_user_id', 'a0000000-0000-4000-8000-000000000001', false) \g /dev/null

-- 1 et 2. Le tenant demande ne rend que lui ; le sujet traverse les tenants.
update audit_scope_proof
   set org_rows = (
         select count(*)
           from staff_audit_scope('a1000000-0000-4000-8000-000000000001')
          where source = 'staff_impersonation'
       ),
       org_leak = (
         select count(*)
           from staff_audit_scope('a1000000-0000-4000-8000-000000000001')
          where organization_id <> 'a1000000-0000-4000-8000-000000000001'
       ),
       subject_rows = (
         select count(*)
           from staff_audit_scope(null, 'a2000000-0000-4000-8000-000000000001')
       ),
       both_rows = (
         select count(*)
           from staff_audit_scope(
             'a1000000-0000-4000-8000-000000000001',
             'a2000000-0000-4000-8000-000000000001'
           )
       ),
       actor_rows = (
         select count(*)
           from staff_audit_scope(null, 'a0000000-0000-4000-8000-000000000001')
       );

-- 6. Aucun cadre : refus, jamais le journal global.
do $scope$
begin
  perform count(*) from staff_audit_scope();
  update audit_scope_proof set no_scope = 'leaked';
exception
  when others then
    update audit_scope_proof set no_scope = sqlstate;
end;
$scope$;

-- 5. Sans GUC de staff, puis avec un staff desactive : meme refus.
select set_config('app.staff_user_id', '', false) \g /dev/null
do $scope$
begin
  perform count(*) from staff_audit_scope('a1000000-0000-4000-8000-000000000001');
  update audit_scope_proof set no_guc = 'leaked';
exception
  when others then
    update audit_scope_proof set no_guc = sqlstate;
end;
$scope$;

select set_config('app.staff_user_id', 'a0000000-0000-4000-8000-000000000002', false) \g /dev/null
do $scope$
begin
  perform count(*) from staff_audit_scope('a1000000-0000-4000-8000-000000000001');
  update audit_scope_proof set disabled_staff = 'leaked';
exception
  when others then
    update audit_scope_proof set disabled_staff = sqlstate;
end;
$scope$;
reset role;

select org_rows || '|' || org_leak || '|' || subject_rows || '|' || both_rows
       || '|' || actor_rows || '|' || no_guc || '|' || disabled_staff
       || '|' || no_scope
  from audit_scope_proof;
