-- La PORTE du produit (0068) : la liste d attente porte la validation qui
-- autorise la creation d un compte, et rien d autre ne l autorise.
--
-- Huit faits, dans l ordre du resultat attendu :
--   1. openedbot_api valide une adresse (update accorde par 0068)
--   2. la porte lit le mode d une adresse validee : alpha
--   3. la porte ne lit rien pour une adresse non validee
--   4. un mode sans instant de validation est refuse (contrainte 23514)
--   5. un instant sans mode est refuse (contrainte 23514)
--   6. un mode inconnu est refuse (contrainte 23514)
--   7. le retrait d un acces remet l inscription en attente
--   8. users.access_tier accepte les trois modes et refuse le quatrieme
-- Puis le REFUS (0074), qui garde la ligne au lieu de l effacer :
--   9. la porte ne voit rien pour une adresse refusee
--  10. valider une ligne refusee est refuse (contrainte 23514)
--  11. refuser une ligne validee est refuse (contrainte 23514)
--  12. une note de refus sans refus est refusee (contrainte 23514)
create temp table waitlist_access_proof (
  approved text,
  gate_open text,
  gate_closed text,
  tier_without_instant text,
  instant_without_tier text,
  unknown_tier text,
  revoked text,
  user_tier text,
  rejected_gate text,
  approve_rejected text,
  reject_approved text,
  reason_without_rejection text
);
grant insert, update, select on waitlist_access_proof to openedbot_api;
insert into waitlist_access_proof default values;

insert into waitlist_signups (id, email, locale) values
  ('70000000-0000-4000-8000-000000000001', 'ouvert@gate.test', 'fr'),
  ('70000000-0000-4000-8000-000000000002', 'attente@gate.test', 'en'),
  ('70000000-0000-4000-8000-000000000003', 'validee@gate.test', 'fr');

set role openedbot_api;

update waitlist_signups
   set access_tier = 'alpha',
       approved_at = now(),
       approved_by_staff_user_id = null
 where id = '70000000-0000-4000-8000-000000000001';
update waitlist_access_proof set approved = 'granted';

-- La lecture EXACTE de `auth.ts` : le mode d une adresse validee.
update waitlist_access_proof
   set gate_open = coalesce((select access_tier from waitlist_signups
                              where lower(email) = 'ouvert@gate.test' and approved_at is not null), 'none'),
       gate_closed = coalesce((select access_tier from waitlist_signups
                                where lower(email) = 'attente@gate.test' and approved_at is not null), 'none');

do $$
begin
  update waitlist_signups set access_tier = 'beta', approved_at = null
   where id = '70000000-0000-4000-8000-000000000002';
  update waitlist_access_proof set tier_without_instant = 'accepted';
exception when check_violation then
  update waitlist_access_proof set tier_without_instant = 'refused';
end;
$$;

do $$
begin
  update waitlist_signups set access_tier = null, approved_at = now()
   where id = '70000000-0000-4000-8000-000000000002';
  update waitlist_access_proof set instant_without_tier = 'accepted';
exception when check_violation then
  update waitlist_access_proof set instant_without_tier = 'refused';
end;
$$;

do $$
begin
  update waitlist_signups set access_tier = 'vip', approved_at = now()
   where id = '70000000-0000-4000-8000-000000000002';
  update waitlist_access_proof set unknown_tier = 'accepted';
exception when check_violation then
  update waitlist_access_proof set unknown_tier = 'refused';
end;
$$;

update waitlist_signups
   set access_tier = null, approved_at = null, approved_by_staff_user_id = null
 where id = '70000000-0000-4000-8000-000000000001';
update waitlist_access_proof
   set revoked = coalesce((select access_tier from waitlist_signups
                            where lower(email) = 'ouvert@gate.test' and approved_at is not null), 'none');

-- LE REFUS (0074). L adresse reste dans la liste : c est ce qui l empeche de
-- se reinscrire depuis la page publique, puisque l adresse est unique.
update waitlist_signups
   set rejected_at = now(),
       rejected_by_staff_user_id = null,
       rejection_reason = 'sonde automatisee'
 where id = '70000000-0000-4000-8000-000000000002';
update waitlist_access_proof
   set rejected_gate = coalesce((select access_tier from waitlist_signups
                                  where lower(email) = 'attente@gate.test' and approved_at is not null), 'none');

-- Valider une ligne refusee : la base refuse, et c est ce qui rend inutile une
-- condition de plus dans `auth.ts`. Le refus se leve d abord.
do $$
begin
  update waitlist_signups set access_tier = 'alpha', approved_at = now()
   where id = '70000000-0000-4000-8000-000000000002';
  update waitlist_access_proof set approve_rejected = 'accepted';
exception when check_violation then
  update waitlist_access_proof set approve_rejected = 'refused';
end;
$$;

-- L inverse, sur une ligne validee : l acces se retire d abord, ce qui
-- previent la personne.
update waitlist_signups
   set access_tier = 'alpha', approved_at = now(), approved_by_staff_user_id = null
 where id = '70000000-0000-4000-8000-000000000003';
do $$
begin
  update waitlist_signups set rejected_at = now()
   where id = '70000000-0000-4000-8000-000000000003';
  update waitlist_access_proof set reject_approved = 'accepted';
exception when check_violation then
  update waitlist_access_proof set reject_approved = 'refused';
end;
$$;

-- Une note sans refus serait un commentaire que rien n afficherait.
do $$
begin
  update waitlist_signups set rejection_reason = 'orpheline'
   where id = '70000000-0000-4000-8000-000000000001';
  update waitlist_access_proof set reason_without_rejection = 'accepted';
exception when check_violation then
  update waitlist_access_proof set reason_without_rejection = 'refused';
end;
$$;

reset role;

-- Le mode recopie sur le compte cree. Trois valeurs passent, la quatrieme non.
do $$
declare
  accepted int := 0;
begin
  insert into users (id, email, access_tier) values
    ('70000000-0000-4000-8000-000000000011', 'alpha@gate.test', 'alpha'),
    ('70000000-0000-4000-8000-000000000012', 'beta@gate.test', 'beta'),
    ('70000000-0000-4000-8000-000000000013', 'classic@gate.test', 'classic');
  select count(*) into accepted from users where access_tier is not null;
  begin
    insert into users (id, email, access_tier)
    values ('70000000-0000-4000-8000-000000000014', 'vip@gate.test', 'vip');
    update waitlist_access_proof set user_tier = accepted::text || '/accepted';
  exception when check_violation then
    update waitlist_access_proof set user_tier = accepted::text || '/refused';
  end;
end;
$$;

select approved || '|' || gate_open || '|' || gate_closed || '|' || tier_without_instant
       || '|' || instant_without_tier || '|' || unknown_tier || '|' || revoked || '|' || user_tier
       || '|' || rejected_gate || '|' || approve_rejected || '|' || reject_approved
       || '|' || reason_without_rejection
  from waitlist_access_proof;
