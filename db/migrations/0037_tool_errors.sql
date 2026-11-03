begin;

-- Les échecs d'outils d'un tenant, une ligne par `tool.result` en erreur.
--
-- Pourquoi une table et pas une lecture de `run_events` : `run_events` est un
-- tampon de LIVRAISON SSE, purgé au-delà de `WORKER_RUN_EVENTS_RETENTION_DAYS`
-- (0012), et son payload n'est pas indexable par bot. « Quels outils cassent
-- sur ce bot, et pourquoi » est une question d'exploitation qui doit survivre
-- à la purge du fil et se répondre par un index, pas par un balayage JSON.
--
-- `error_message` est le texte BORNÉ et RÉDIGÉ par
-- `sanitizeToolErrorMessage` (modules/execution/src/domain/hermes-events.ts) :
-- 500 caractères, sans séquence ANSI, secrets masqués. Il est NULL quand le
-- runtime n'a rien dit : mesuré sur `/v1/runs` (hermes-agent
-- `gateway/platforms/api_server_runs.py`) : `tool.completed` ne porte que
-- `tool`, `duration` et `error` booléen. La ligne existe quand même : l'échec
-- est un fait, son explication un bonus.
--
-- `user_id` est l'opérateur qui a envoyé le message d'origine du run, relu
-- dans `message_ingress` (0005) au moment de l'insertion, c'est la seule
-- table qui relie un run à son auteur humain. NULL pour une routine, un
-- webhook, un hand-off ou un run de service : personne n'a tapé ce message.
create table tool_errors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bot_id          uuid not null,
  thread_id       uuid not null,
  run_id          uuid not null,
  user_id         uuid,
  tool            text not null,
  tool_call_id    text not null,
  error_message   text,
  duration_ms     integer,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  -- La purge d'un bot emporte ses erreurs : elles ne décrivent que lui.
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references runs(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete set null (user_id),
  constraint tool_errors_message_bounded check (error_message is null or length(error_message) <= 500),
  constraint tool_errors_duration_nonnegative check (duration_ms is null or duration_ms >= 0)
);

-- Le panneau Capacités d'un bot lit ses dernières erreurs.
create index tool_errors_bot_occurred_idx
  on tool_errors (organization_id, bot_id, occurred_at desc, id desc);
-- Une vue d'organisation, et la purge par ancienneté.
create index tool_errors_org_occurred_idx
  on tool_errors (organization_id, occurred_at desc);

comment on table tool_errors is
  'Échecs d''outils par tenant : une ligne par `tool.result` en erreur, écrite par le worker dans la transaction de l''événement. `error_message` est borné (500) et rédigé (secrets masqués) ; NULL quand le runtime n''a transmis aucun texte. Purgée par le worker au-delà de `WORKER_TOOL_ERRORS_RETENTION_DAYS`. La suppression d''un bot, d''un fil ou d''un run emporte ses lignes.';

alter table tool_errors enable row level security;
alter table tool_errors force row level security;

create policy tool_errors_tenant on tool_errors to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy tool_errors_worker on tool_errors to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on tool_errors to ohb_api;
grant select, insert, update, delete on tool_errors to ohb_worker;

insert into schema_migrations(version) values ('0037_tool_errors')
on conflict (version) do nothing;

commit;
