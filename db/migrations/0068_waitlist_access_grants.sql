-- La liste d'attente devient la PORTE d'entrée du produit : jusqu'ici elle ne
-- servait qu'à collecter des adresses, et l'accès à l'application se décidait
-- ailleurs, par une liste d'adresses IP dans Caddy et par la variable
-- `GOOGLE_ALLOWED_EMAILS`. Ni l'une ni l'autre ne sait dire « cette personne-là
-- peut entrer » : la première nomme un réseau, la seconde exige un
-- redéploiement.
--
-- Une inscription porte donc maintenant sa validation, et rien de plus :
--
--   `access_tier`   le mode d'accès accordé : `alpha`, `beta` ou `classic`.
--                   Les trois ouvrent la même chose aujourd'hui ; le mode est
--                   retenu pour que la règle qui les distinguera un jour ait
--                   une donnée à lire, et pour que le backoffice sache de qui
--                   il parle.
--   `approved_at`   l'instant de la validation. C'est LUI qui ouvre la porte,
--                   pas le mode.
--   `approved_by_staff_user_id`  qui a validé, pour que la décision ait un
--                   auteur. `on delete set null` : un départ de l'équipe ne
--                   doit jamais refermer un accès déjà accordé.
--
-- Les deux premières colonnes vont ensemble ou pas du tout : un mode sans
-- instant serait un accès qu'aucune route ne reconnaît, un instant sans mode un
-- accès que le backoffice ne sait pas nommer. La contrainte le dit.
--
-- `ohb_api` gagne l'`update`, et seulement lui : la route publique
-- `POST /api/waitlist` garde sa discipline d'écriture seule (0065), les routes
-- staff lisent depuis 0066, et rien ici n'ouvre la liste au chemin public.
--
-- Le mode est recopié sur le compte à sa création (`users.access_tier`) : le
-- jour où l'inscription est retirée de la liste, on doit encore savoir sous
-- quel mode ce compte est entré.
begin;

alter table waitlist_signups
  add column if not exists access_tier text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by_staff_user_id uuid references staff_users(id) on delete set null;

alter table waitlist_signups
  drop constraint if exists waitlist_signups_access_tier_check;
alter table waitlist_signups
  add constraint waitlist_signups_access_tier_check
  check (access_tier is null or access_tier in ('alpha', 'beta', 'classic'));

alter table waitlist_signups
  drop constraint if exists waitlist_signups_approval_complete_check;
alter table waitlist_signups
  add constraint waitlist_signups_approval_complete_check
  check ((access_tier is null) = (approved_at is null));

-- La porte d'authentification cherche une adresse déjà normalisée en
-- minuscules, mais compare en `lower(...)` : sans cet index, chaque connexion
-- balaierait la liste entière.
create index if not exists waitlist_signups_email_lower_idx
  on waitlist_signups (lower(email));
-- Le backoffice filtre « validés » / « en attente » sur une liste triée par date.
create index if not exists waitlist_signups_approved_at_idx
  on waitlist_signups (approved_at desc)
  where approved_at is not null;

grant update on waitlist_signups to ohb_api;

-- Le mode sous lequel ce compte est entré. `null` pour tous les comptes
-- existants : ils sont nés avant la porte, et rien ne doit leur inventer un
-- mode qu'aucun humain n'a accordé.
alter table users
  add column if not exists access_tier text;
alter table users
  drop constraint if exists users_access_tier_check;
alter table users
  add constraint users_access_tier_check
  check (access_tier is null or access_tier in ('alpha', 'beta', 'classic'));

-- Le message d'ouverture d'accès rejoint la file transactionnelle. La
-- contrainte de genre (0064) est la jumelle SQL de `TRANSACTIONAL_EMAIL_KINDS`
-- (`contracts/api/src/email-kinds.ts`) : un genre déposé sans son gabarit
-- part en échec de rendu chez le worker, un genre rendu sans sa contrainte
-- n'entre jamais dans la file.
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted'
  ));

insert into schema_migrations(version) values ('0068_waitlist_access_grants')
on conflict (version) do nothing;

commit;
