begin;

-- L'onboarding devient un fait sur la PERSONNE, plus seulement sur l'espace.
--
-- Jusqu'ici la sortie de l'accueil vivait uniquement dans
-- `organizations.onboarded_at` (0001) : le premier membre qui finissait le
-- parcours le fermait pour tout l'espace. Le gate applicatif (`/` qui
-- redirige vers `/onboarding`) lit désormais `users.onboarding_completed`,
-- un booléen PAR UTILISATEUR : chaque personne a fait, ou non, son propre
-- parcours. `organizations.onboarded_at` et `organizations.onboarding`
-- restent : ils datent la sortie de l'espace et gardent les réponses, mais ne
-- décident plus de l'entrée.
--
-- `users` n'est pas sous RLS et `openedbot_api` porte déjà un grant table entier
-- (0001) : la nouvelle colonne est lisible et modifiable par l'API sans
-- grant supplémentaire. `openedbot_worker` ne lit que (id, email) (0002) et n'a
-- rien à faire de ce flag.
alter table users
  add column onboarding_completed boolean not null default false;

comment on column users.onboarding_completed is
  'Flag par utilisateur : true quand cette personne a terminé son accueil. Remplace le gate par organisation (onboarded_at) côté application.';

-- Reprise de l'existant : quiconque est membre d'au moins un espace déjà
-- onboardé a, de fait, franchi l'accueil. Personne ne doit le revoir à cause
-- de cette migration.
update users u
   set onboarding_completed = true
 where exists (
   select 1
     from memberships m
     join organizations o on o.id = m.organization_id
    where m.user_id = u.id
      and o.onboarded_at is not null
 );

insert into schema_migrations(version) values ('0025_user_onboarding_completed')
on conflict (version) do nothing;

commit;
