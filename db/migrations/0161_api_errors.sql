begin;

-- Le journal des erreurs NON prévues de l'API, une ligne par 500
-- `INTERNAL_ERROR`, clefée par la référence que l'écran affiche
-- (« … (référence b98c6d00-…) »).
--
-- Pourquoi une table et pas seulement la ligne `api.unhandled_error` du
-- journal : la référence lue par l'utilisateur ne désignait qu'une ligne de
-- stdout, perdue au redémarrage du conteneur ou noyée dans la rotation. Quand
-- quelqu'un écrit au support trois jours plus tard en citant la référence,
-- l'opérateur doit pouvoir la relire par une requête, pas par un grep :
--
--   select * from api_errors where reference = '<référence>';
--
-- `reference` est l'identifiant de requête (`requestIdOf`, `X-Request-Id`),
-- toujours un `crypto.randomUUID()` produit par l'API, jamais lu d'un en-tête
-- client : la clé primaire ne peut pas être imposée de l'extérieur.
--
-- Ce qui n'est JAMAIS écrit : corps de requête, en-têtes, cookies, jetons,
-- query string. `route` est le motif Hono (`/api/bots/:botId`) ; `path` est le
-- chemin SANS query string, ses segments opaques longs (un jeton
-- d'invitation dans `/api/member-invitations/:token`) remplacés par
-- `[redacted]` ; `message` et `stack` passent par `sanitizeDiagnosticText`
-- (modules/runtime-link/src/domain/diagnostics.ts) et sont bornés ici aussi.
-- Le `detail` PostgreSQL n'est pas recopié : il porte les valeurs d'une ligne
-- (`Key (email)=(…)`), c'est-à-dire des données personnelles ; il reste dans
-- la ligne de journal.
--
-- L'écriture est asynchrone et best-effort (apps/api/src/interfaces/http/
-- unhandled-error-journal.ts) : après la réponse, jamais à sa place ; au-delà
-- de quelques écritures en vol, la ligne est abandonnée et comptée, une
-- avalanche d'erreurs ne vide pas le pool de connexions.
--
-- RLS :
-- - openedbot_api n'a QUE `insert`, sans policy de lecture : l'API écrit le journal,
--   elle ne le relit pas. Une ligne d'organisation s'écrit sous `withTenant`
--   (le `with check` exige la même organisation que `app.organization_id`) ;
--   une requête sans organisation (non authentifiée, compte sans espace)
--   écrit `organization_id` NULL, sans réglage.
-- - openedbot_worker ne voit et ne supprime que les lignes de plus de 90 jours : la
--   policy EST la rétention, le worker n'a jamais accès à une erreur fraîche.
-- - la lecture par référence se fait hors rôles applicatifs (superutilisateur
--   ou rôle de migration, qui contournent la RLS) ; aucun backoffice du cœur
--   ne la sert.
--
-- La suppression d'une organisation emporte ses lignes ; celle d'un compte
-- détache `user_id`.
create table api_errors (
  reference       uuid primary key,
  occurred_at     timestamptz not null,
  organization_id uuid references organizations(id) on delete cascade,
  user_id         uuid references users(id) on delete set null,
  method          text not null,
  route           text,
  path            text not null,
  error_code      text not null,
  pg_code         text,
  cause           text not null,
  message         text not null,
  stack           text,
  created_at      timestamptz not null default now(),
  constraint api_errors_method_bounded check (length(method) <= 16),
  constraint api_errors_route_bounded check (route is null or length(route) <= 512),
  constraint api_errors_path_bounded check (length(path) <= 512),
  constraint api_errors_code_bounded check (length(error_code) <= 64),
  constraint api_errors_pg_code_shape check (pg_code is null or pg_code ~ '^[0-9A-Z]{5}$'),
  constraint api_errors_cause_bounded check (length(cause) <= 256),
  constraint api_errors_message_bounded check (length(message) <= 1024),
  constraint api_errors_stack_bounded check (stack is null or length(stack) <= 8192)
);

-- La purge par ancienneté, et « les dernières erreurs » d'un incident.
create index api_errors_occurred_idx on api_errors (occurred_at desc);
-- Les erreurs d'une organisation, quand elle écrit au support.
create index api_errors_org_occurred_idx
  on api_errors (organization_id, occurred_at desc)
  where organization_id is not null;

comment on table api_errors is
  'Erreurs non prévues de l''API (500 INTERNAL_ERROR), une ligne par référence affichée à l''utilisateur. Écriture asynchrone best-effort par openedbot_api (insert seul). Ni corps, ni en-têtes, ni query string ; message et pile rédigés et bornés. Le worker purge au-delà de 90 jours (policy api_errors_worker_*). Lecture : select * from api_errors where reference = ''<référence>''.';

alter table api_errors enable row level security;
alter table api_errors force row level security;

create policy api_errors_api_insert on api_errors for insert to openedbot_api
  with check (
    organization_id is null
    or organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
  );
create policy api_errors_worker_expired on api_errors for select to openedbot_worker
  using (occurred_at < now() - interval '90 days');
create policy api_errors_worker_purge on api_errors for delete to openedbot_worker
  using (occurred_at < now() - interval '90 days');

grant insert on api_errors to openedbot_api;
grant select, delete on api_errors to openedbot_worker;

insert into schema_migrations(version) values ('0161_api_errors')
on conflict (version) do nothing;

commit;
