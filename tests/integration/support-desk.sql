-- Le guichet de support : la porte invitee ne voit qu un fil, la porte staff
-- voit les deux, un GUC invente n ouvre rien, et une ecriture croisee est
-- refusee par la policy et non par le where de l application.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.
--
-- Le compte staff 8000...0081 est cree par staff-cross-tenant.sql, joue avant
-- celui-ci. Le supposer ici serait fragile : il est donc insere si absent.

create temp table support_proof (
  guest_a_conversations int,
  guest_a_messages int,
  guest_a_events int,
  guest_b_conversations int,
  cross_write text,
  no_gate int,
  fake_staff int,
  live_staff int,
  live_staff_messages int,
  recipients int,
  account_conversations int,
  account_anonymous int,
  other_account int
);
insert into support_proof values (-1, -1, -1, -1, 'unset', -1, -1, -1, -1, -1, -1, -1, -1);

insert into staff_users (id, email, password_hash, display_name)
values ('80000000-0000-4000-8000-000000000081', 'staff@example.test', 'x', 'Staff')
on conflict (id) do nothing;

-- Un second compte, desactive : l avis ne doit jamais partir vers lui. Le
-- compte est le SEUL moyen d apprendre qu un fil s est ouvert, donc en oublier
-- un vivant serait un silence, et en garder un mort une adresse qui rebondit.
insert into staff_users (id, email, password_hash, display_name, disabled_at)
values ('80000000-0000-4000-8000-000000000082', 'partie@example.test', 'x', 'Partie', now())
on conflict (id) do nothing;

-- Deux comptes operateurs : le fil du premier suit son COMPTE (porte 0078),
-- celui du second ne doit jamais lui apparaitre.
insert into users (id, email) values
  ('32000000-0000-4000-8000-000000000051', 'operateur-a@example.test'),
  ('32000000-0000-4000-8000-000000000052', 'operateur-b@example.test')
on conflict (id) do nothing;

-- Deux fils, deux jetons. Le condensat fait 64 caracteres, comme un sha256.
-- Le fil A n appartient a AUCUN compte : c est un visiteur sans compte, et la
-- porte compte ne doit pas le voir, meme en cherchant.
insert into support_conversations (id, guest_token_hash, email) values
  ('30000000-0000-4000-8000-000000000031', repeat('a', 64), 'invite-a@example.test'),
  ('30000000-0000-4000-8000-000000000032', repeat('b', 64), 'invite-b@example.test');
insert into support_conversations (id, guest_token_hash, email, user_id) values
  ('30000000-0000-4000-8000-000000000033', repeat('c', 64), 'operateur-a@example.test',
   '32000000-0000-4000-8000-000000000051'),
  ('30000000-0000-4000-8000-000000000034', repeat('d', 64), 'operateur-b@example.test',
   '32000000-0000-4000-8000-000000000052');
insert into support_messages (id, conversation_id, author, body) values
  ('30000000-0000-4000-8000-000000000041', '30000000-0000-4000-8000-000000000031', 'guest', 'bonjour'),
  ('30000000-0000-4000-8000-000000000042', '30000000-0000-4000-8000-000000000032', 'guest', 'bonsoir');
insert into support_events (conversation_id, type, payload) values
  ('30000000-0000-4000-8000-000000000031', 'support.opened', '{}'::jsonb),
  ('30000000-0000-4000-8000-000000000032', 'support.opened', '{}'::jsonb);

grant select, insert, update on support_proof to ohb_api;

-- 1. Porte invitee A : son fil, son message, son evenement. Et rien du fil B.
set role ohb_api;
select set_config('app.support_guest_token_hash', repeat('a', 64), false) \g /dev/null
select set_config('app.staff_user_id', '', false) \g /dev/null
update support_proof
   set guest_a_conversations = (select count(*) from support_conversations),
       guest_a_messages = (select count(*) from support_messages),
       guest_a_events = (select count(*) from support_events),
       guest_b_conversations = (
         select count(*) from support_conversations
          where id = '30000000-0000-4000-8000-000000000032'
       );
reset role;

-- 2. Ecriture croisee : le with check de la policy du parent la refuse.
set role ohb_api;
select set_config('app.support_guest_token_hash', repeat('a', 64), false) \g /dev/null
do $support$
begin
  insert into support_messages (id, conversation_id, author, body)
  values ('30000000-0000-4000-8000-000000000043', '30000000-0000-4000-8000-000000000032', 'guest', 'intrusion');
  update support_proof set cross_write = 'leaked';
exception
  when others then
    update support_proof set cross_write = 'denied';
end;
$support$;
reset role;

-- 3. Aucune porte : rien.
set role ohb_api;
select set_config('app.support_guest_token_hash', '', false) \g /dev/null
select set_config('app.staff_user_id', '', false) \g /dev/null
update support_proof set no_gate = (select count(*) from support_conversations);
reset role;

-- 4. Un identifiant staff qui ne designe personne n ouvre rien : la fonction
--    support_staff_session() exige un compte existant et non desactive.
set role ohb_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-0000000000ff', false) \g /dev/null
update support_proof set fake_staff = (select count(*) from support_conversations);
reset role;

-- 5. Session staff vivante : les deux fils, et les destinataires de l avis.
set role ohb_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000081', false) \g /dev/null
update support_proof
   set live_staff = (select count(*) from support_conversations),
       live_staff_messages = (select count(*) from support_messages),
       -- Borne aux deux comptes de cette preuve : un compte staff cree par
       -- une autre preuve du meme fichier ne doit pas changer le verdict.
       recipients = (
         select count(*) from support_notify_recipients() r
          where r.staff_user_id in (
            '80000000-0000-4000-8000-000000000081',
            '80000000-0000-4000-8000-000000000082'
          )
       );
reset role;

-- 6. Porte COMPTE (0078) : les fils de ce compte, et rien d autre. Ni le fil
--    anonyme, ni celui d un autre compte. C est ce qui rend l historique
--    possible depuis une autre machine, sans elargir quoi que ce soit.
set role ohb_api;
select set_config('app.support_guest_token_hash', '', false) \g /dev/null
select set_config('app.staff_user_id', '', false) \g /dev/null
select set_config('app.support_user_id', '32000000-0000-4000-8000-000000000051', false) \g /dev/null
update support_proof
   set account_conversations = (select count(*) from support_conversations),
       account_anonymous = (
         select count(*) from support_conversations
          where id = '30000000-0000-4000-8000-000000000031'
       ),
       other_account = (
         select count(*) from support_conversations
          where id = '30000000-0000-4000-8000-000000000034'
       );
reset role;

select guest_a_conversations || '/' || guest_a_messages || '/' || guest_a_events
       || '/' || guest_b_conversations || '/' || cross_write || '/' || no_gate
       || '/' || fake_staff || '/' || live_staff || '/' || live_staff_messages
       || '/' || recipients
       || '/' || account_conversations || '/' || account_anonymous || '/' || other_account
  from support_proof;
