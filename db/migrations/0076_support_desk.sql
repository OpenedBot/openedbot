-- Le guichet de support : un visiteur écrit depuis la page publique, le staff
-- lui répond depuis le backoffice. Aucun modèle n'est appelé, aucun bot n'est
-- créé, aucun run n'est mis en file : ce sont deux humains et un fil.
--
-- HORS TENANT, comme la liste d'attente : au moment où un visiteur écrit, il
-- n'y a pas d'organisation, et le staff n'en a jamais. Mais contrairement à
-- `waitlist_signups`, qui ne porte qu'une adresse, ces tables portent du
-- CONTENU DE MESSAGE. Elles prennent donc la RLS, plutôt que de s'en remettre
-- au seul `where` de l'application.
--
-- Deux portes, mutuellement exclusives, toutes deux déjà dans `db.ts` :
--
--   `app.support_guest_token_hash`  la porte invité, posée par
--                   `withSupportGuest` sur le modèle exact de
--                   `withCredential`. La valeur est TOUJOURS le SHA-256 du
--                   jeton, jamais le jeton.
--   `app.staff_user_id`             la porte staff, posée par `withStaffUser`
--                   depuis 0023. `support_staff_session()` vérifie en plus
--                   que ce compte existe et n'est pas désactivé : un GUC
--                   inventé n'ouvre rien.
--
-- Un invité n'a aucun moyen de poser la seconde, une session staff aucune
-- raison de poser la première. Le cloisonnement est donc structurel, et une
-- seule place le définit : les policies de `support_conversations`. Celles de
-- `support_messages` et `support_events` ne font que déléguer au parent par un
-- `exists`, dont la sous-requête est elle-même soumise à la RLS du parent.
begin;

-- Vrai quand la transaction courante porte une session staff vivante.
--
-- Pas de `security definer` : la fonction tourne comme `ohb_api` et s'appuie
-- sur la policy `staff_users_api` de 0023, qui laisse voir exactement la ligne
-- dont l'`id` vaut `app.staff_user_id`. Le droit n'est donc élargi nulle part,
-- et un GUC qui ne désigne personne rend `false`.
create or replace function support_staff_session()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.staff_users su
     where su.id = nullif(current_setting('app.staff_user_id', true), '')::uuid
       and su.disabled_at is null
  );
$$;
revoke all on function support_staff_session() from public;
grant execute on function support_staff_session() to ohb_api;

-- Un jeton, une conversation, pour toujours.
--
-- Le jeton du visiteur voyage dans un en-tête (`X-OHB-Support-Token`), pas
-- dans un cookie : une route publique sans cookie n'a pas de surface CSRF.
-- Effacer les données du site perd donc l'accès au fil, et c'est précisément
-- pourquoi `email` est obligatoire : le staff garde un moyen de répondre.
--
-- `status` n'a que deux valeurs. Un fil fermé se réouvre au message suivant :
-- c'est ce que fait un vrai guichet, et cela évite un troisième état qui
-- voudrait dire « fermé mais pas vraiment ».
create table support_conversations (
  id uuid primary key,
  guest_token_hash text not null unique,
  email text not null,
  locale text not null default 'fr' check (locale in ('fr', 'en')),
  status text not null default 'open' check (status in ('open', 'closed')),
  -- Le premier staff qui répond s'attribue le fil. `on delete set null` : un
  -- départ de l'équipe ne doit pas emporter la conversation.
  assigned_staff_user_id uuid references staff_users(id) on delete set null,
  -- Renseigné seulement si un opérateur déjà connecté ouvre le guichet. Il
  -- reste un invité du point de vue du support : aucune organisation n'entre
  -- dans ce fil.
  user_id uuid references users(id) on delete set null,
  last_guest_message_at timestamptz,
  last_staff_message_at timestamptz,
  staff_read_at timestamptz,
  guest_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(email) between 3 and 320),
  check (length(guest_token_hash) = 64)
);

-- La liste du backoffice : les fils ouverts d'abord, le plus récemment parlant
-- en tête. Sans cet index, chaque ouverture de l'inbox balaie la table.
create index support_conversations_status_idx
  on support_conversations (status, last_guest_message_at desc nulls last, created_at desc);
create index support_conversations_email_lower_idx
  on support_conversations (lower(email));

comment on table support_conversations is
  'Un fil de support par jeton invité. Hors tenant : aucune organisation n''existe quand un visiteur écrit. La porte invité est le condensat du jeton, la porte staff une session staff vivante.';

create table support_messages (
  id uuid primary key,
  conversation_id uuid not null references support_conversations(id) on delete cascade,
  -- `check` à valeurs nommées plutôt qu'un booléen : le jour où un agent
  -- répond, `'agent'` s'ajoute ici et nulle part ailleurs.
  author text not null check (author in ('guest', 'staff')),
  -- Qui a répondu, pour que la réponse ait un auteur. Toujours nul côté
  -- invité, toujours renseigné côté staff (la contrainte le dit).
  staff_user_id uuid references staff_users(id) on delete set null,
  body text not null,
  -- L'idempotence d'un POST rejoué : réseau coupé, doigt impatient, retry du
  -- client. Nul quand l'appelant n'en fournit pas, et l'index unique tolère
  -- alors les doublons plutôt que de refuser le second message.
  idempotency_key text,
  created_at timestamptz not null default now(),
  check (length(body) between 1 and 4000),
  check ((author = 'staff') = (staff_user_id is not null)),
  check (idempotency_key is null or length(idempotency_key) between 8 and 200)
);

create unique index support_messages_idempotency_idx
  on support_messages (conversation_id, author, idempotency_key)
  where idempotency_key is not null;
create index support_messages_thread_idx
  on support_messages (conversation_id, created_at asc, id asc);

comment on table support_messages is
  'Les messages d''un fil de support. `author` nomme le côté ; un seul index unique partiel porte l''idempotence d''un POST rejoué.';

-- La table du flux. Copie assumée de `run_events` : un curseur `identity`
-- global, monotone, qui sert de `Last-Event-ID` aux deux flux SSE.
--
-- Le curseur doit être alloué dans l'ORDRE DE COMMIT, sinon deux écritures
-- concurrentes livrent 42 avant 41 et un abonné perd une ligne. C'est le rôle
-- du `pg_advisory_xact_lock` pris par `support-desk.ts` avant chaque insert,
-- exactement comme `lockRunEventCursorTx` le fait pour `run_events`.
create table support_events (
  cursor bigint generated always as identity primary key,
  conversation_id uuid not null references support_conversations(id) on delete cascade,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object'),
  check (length(type) between 1 and 100)
);

-- Le flux staff lit tous les fils, le flux invité un seul : deux index, pas un.
create index support_events_conversation_cursor_idx
  on support_events (conversation_id, cursor);

comment on table support_events is
  'Le flux SSE du guichet. `cursor` est le Last-Event-ID des deux portées : un fil pour l''invité, tous les fils pour le staff.';

alter table support_conversations enable row level security;
alter table support_conversations force row level security;
alter table support_messages enable row level security;
alter table support_messages force row level security;
alter table support_events enable row level security;
alter table support_events force row level security;

-- L'invité ne voit QUE le fil dont il porte le jeton. L'insertion passe la
-- même barrière : `withSupportGuest` pose le GUC avant d'écrire la ligne,
-- donc le `with check` de l'ouverture est satisfait par construction.
create policy support_conversations_guest on support_conversations to ohb_api
  using (guest_token_hash = nullif(current_setting('app.support_guest_token_hash', true), ''))
  with check (guest_token_hash = nullif(current_setting('app.support_guest_token_hash', true), ''));

create policy support_conversations_staff on support_conversations to ohb_api
  using (support_staff_session())
  with check (support_staff_session());

-- Les deux tables filles délèguent au parent : la sous-requête est soumise à
-- la RLS de `support_conversations`, donc « qui voit quoi » n'est défini qu'une
-- fois, au-dessus.
create policy support_messages_scope on support_messages to ohb_api
  using (exists (select 1 from public.support_conversations c where c.id = conversation_id))
  with check (exists (select 1 from public.support_conversations c where c.id = conversation_id));

create policy support_events_scope on support_events to ohb_api
  using (exists (select 1 from public.support_conversations c where c.id = conversation_id))
  with check (exists (select 1 from public.support_conversations c where c.id = conversation_id));

-- Le worker ne fait que purger, comme sur toute autre table.
create policy support_conversations_worker on support_conversations to ohb_worker
  using (true) with check (true);
create policy support_messages_worker on support_messages to ohb_worker
  using (true) with check (true);
create policy support_events_worker on support_events to ohb_worker
  using (true) with check (true);

-- 0063 avait créé la liste d'attente SANS aucun droit : toute inscription
-- sortait en 500 sur `permission denied for table`. Les droits sont donc
-- posés ici, dans la même migration que les tables.
--
-- `delete` sur les conversations, et sur elles seules : le staff doit pouvoir
-- effacer un fil sur demande. Un visiteur n'a pas de compte, donc aucun écran
-- d'où demander son effacement lui-même, et la rétention à six mois n'est pas
-- une réponse à une demande. Les messages et les événements partent par
-- cascade : un message qu'on ne pourrait supprimer qu'un par un laisserait
-- toujours un reste.
grant select, insert, update, delete on support_conversations to ohb_api;
grant select, insert on support_messages to ohb_api;
grant select, insert on support_events to ohb_api;
grant select, insert, update, delete on support_conversations to ohb_worker;
grant select, insert, update, delete on support_messages to ohb_worker;
grant select, insert, update, delete on support_events to ohb_worker;

-- Les destinataires de l'avis « nouveau fil de support ».
--
-- `security definer` est obligatoire ici : `staff_users_api` (0023) ne laisse
-- un compte staff voir que LUI-MÊME, et l'avis part d'une transaction invité
-- qui ne porte aucune identité staff. La fonction ne rend que ce qu'il faut
-- pour adresser un e-mail, jamais un condensat de mot de passe.
create or replace function support_notify_recipients()
returns table (staff_user_id uuid, email text)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select su.id, su.email
    from public.staff_users su
   where su.disabled_at is null
   order by su.created_at asc
$$;
revoke all on function support_notify_recipients() from public;
grant execute on function support_notify_recipients() to ohb_api;

-- La contrainte de genre est la jumelle SQL de `TRANSACTIONAL_EMAIL_KINDS`
-- (`contracts/api/src/email-kinds.ts`) : un genre déposé sans son
-- gabarit part en échec de rendu chez le worker, un genre rendu sans sa
-- contrainte n'entre jamais dans la file.
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created',
    'staff_password_reset',
    'support_new_conversation'
  ));

insert into schema_migrations(version) values ('0076_support_desk')
on conflict (version) do nothing;

commit;
