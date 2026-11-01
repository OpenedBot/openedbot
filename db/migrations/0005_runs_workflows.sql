begin;

-- Exécution : runs, workflows (l'enveloppe bornée et durable autour d'un ou
-- plusieurs runs), flux d'événements SSE, steering d'un run actif et
-- réservation durable d'ingress de messages.
--
-- Cycle FK assumé : runs.workflow_id -> workflows et workflows.root_run_id ->
-- runs (différée). Les deux tables vivent dans ce fichier ; la FK runs ->
-- workflows est ajoutée après la création de workflows.

-- Le courrier de hand-off ('relaying') n'appelle jamais Hermes : jamais
-- réclamé par la file ('queued' seulement) ni fauché par le moissonneur de
-- baux, mais il occupe son fil. 'unknown' est un état de réconciliation
-- délibéré et visible : il reste actif pour qu'un second run ne démarre pas
-- tant que l'issue externe n'est pas résolue. `lease_generation` est le
-- fencing token : un writer rejette le travail produit sous un bail périmé.
create table runs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  bot_id uuid,
  group_turn_position integer,
  input text not null,
  status text not null default 'queued',
  model text,
  hermes_run_id text,
  output text,
  usage jsonb,
  error_code text,
  error_message text,
  last_hermes_sequence integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  group_state jsonb,
  handoff_target_bot_id uuid,
  origin_run_id uuid,
  next_attempt_at timestamptz,
  lease_generation bigint not null default 0,
  external_state text not null default 'not_started',
  events_complete boolean not null default true,
  remote_stop_state text,
  workflow_id uuid,
  step_index integer,
  step_kind text,
  stack_depth integer not null default 0,
  caller_bot_id uuid,
  caller_run_id uuid,
  resumes_run_id uuid,
  completion_kind text,
  execution_session_key text,
  unique (organization_id, id),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  -- FK composite : seul bot_id est annulé à la suppression du bot,
  -- organization_id (not null) reste : l'historique survit, anonymisé.
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete set null (bot_id),
  constraint runs_status_check
    check (status in (
      'queued', 'starting', 'running', 'awaiting_approval', 'relaying',
      'unknown', 'completed', 'failed', 'cancelled'
    )),
  constraint runs_lease_generation_nonnegative
    check (lease_generation >= 0),
  constraint runs_external_state_check
    check (external_state in (
      'not_started', 'creating', 'streaming', 'polling', 'stopping', 'settled', 'ambiguous'
    )),
  constraint runs_remote_stop_state_check
    check (remote_stop_state is null or remote_stop_state in (
      'requested', 'confirmed', 'ambiguous', 'failed'
    )),
  constraint runs_step_index_nonnegative
    check (step_index is null or step_index >= 0),
  constraint runs_step_kind_check
    check (step_kind is null or step_kind in ('root', 'delegated', 'continuation', 'group')),
  constraint runs_stack_depth_check
    check (stack_depth between 0 and 4),
  constraint runs_completion_kind_length_check
    check (completion_kind is null or length(completion_kind) between 1 and 64),
  constraint runs_execution_session_key_length_check
    check (execution_session_key is null or length(execution_session_key) between 1 and 200),
  constraint runs_caller_bot_fkey
    foreign key (organization_id, caller_bot_id)
    references bots(organization_id, id) on delete set null (caller_bot_id),
  constraint runs_caller_run_fkey
    foreign key (organization_id, caller_run_id)
    references runs(organization_id, id) on delete set null (caller_run_id),
  constraint runs_resumes_run_fkey
    foreign key (organization_id, resumes_run_id)
    references runs(organization_id, id) on delete set null (resumes_run_id)
);

create index runs_queue_idx on runs (status, created_at) where status = 'queued';
create index runs_lease_idx on runs (lease_expires_at)
  where status in ('starting', 'running', 'awaiting_approval', 'unknown');
-- Les follow-ups saisis pendant un run actif restent des workflows racines
-- distincts : plusieurs runs `queued` peuvent attendre sur un même fil, mais
-- une seule frontière externe est active à la fois.
create unique index runs_one_active_per_thread_idx on runs (organization_id, thread_id)
  where status in ('starting', 'running', 'awaiting_approval', 'relaying', 'unknown');
create index runs_thread_queue_idx
  on runs (organization_id, thread_id, created_at, id)
  where status = 'queued';
create index runs_reconciliation_idx on runs (updated_at, organization_id)
  where status = 'unknown'
     or external_state = 'ambiguous'
     or events_complete = false
     or remote_stop_state in ('ambiguous', 'failed');
create index runs_remote_stop_idx on runs (updated_at, organization_id)
  where remote_stop_state in ('requested', 'ambiguous', 'failed');
-- Agrégations d'usage de jetons par période (/api/usage) : plage sur
-- l'horodatage de fin effectif d'un tenant. Non partiel : les sommes d'usage
-- ne filtrent pas le status.
create index runs_org_effective_time_idx on runs (organization_id, (coalesce(ended_at, created_at)));
-- Le panneau « capacités » agrège les tool.call d'un BOT à partir de ses runs.
create index runs_organization_bot_idx
  on runs (organization_id, bot_id)
  where bot_id is not null;

-- Les limites sont copiées depuis la policy du bot à la création : abaisser
-- une policy ne réécrit jamais l'historique, un retry n'acquiert jamais un
-- budget plus grand. Un salon peut exécuter 6 membres sur 3 rounds (max_steps
-- jusqu'à 18) ; le plafond distinct de 10 messages non-pass reste porté par
-- runs.group_state.sent.
create table workflows (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  root_run_id uuid not null,
  root_bot_id uuid,
  initiator_user_id uuid,
  kind text not null check (kind in ('dm', 'group', 'routine')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'awaiting_approval', 'reconciling',
    'completed', 'failed', 'cancelled', 'expired', 'unknown'
  )),
  protocol_version smallint not null default 1 check (protocol_version between 1 and 32767),
  autonomy_enabled boolean not null default false,
  max_depth integer not null default 3 check (max_depth between 1 and 4),
  max_steps integer not null default 8,
  max_handoffs integer not null default 4 check (max_handoffs between 0 and 8),
  timeout_seconds integer not null default 1800 check (timeout_seconds between 60 and 3600),
  token_budget bigint not null default 50000 check (token_budget between 1000 and 200000),
  used_steps integer not null default 0 check (used_steps >= 0),
  used_handoffs integer not null default 0 check (used_handoffs >= 0),
  used_tokens bigint not null default 0 check (used_tokens >= 0),
  deadline_at timestamptz not null default (now() + interval '30 minutes'),
  final_output text,
  error_code text,
  error_message text,
  recovery_state jsonb not null default '{}'::jsonb check (jsonb_typeof(recovery_state) = 'object'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  notification_sequence bigint not null default 0 check (notification_sequence >= 0),
  constraint workflows_max_steps_check check (max_steps between 1 and 18),
  constraint workflows_used_steps_within_budget check (used_steps <= max_steps),
  constraint workflows_used_handoffs_within_budget check (used_handoffs <= max_handoffs),
  unique (organization_id, id),
  unique (organization_id, root_run_id),
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, root_bot_id)
    references bots(organization_id, id) on delete set null (root_bot_id),
  foreign key (organization_id, initiator_user_id)
    references memberships(organization_id, user_id) on delete set null (initiator_user_id),
  -- Le workflow et son run racine sont insérés dans la même transaction. Une
  -- FK différée ferme le trou d'intégrité sans imposer un ordre d'insertion.
  constraint workflows_root_run_fkey
    foreign key (organization_id, root_run_id)
    references runs(organization_id, id)
    on delete restrict
    deferrable initially deferred
);

create index workflows_status_updated_idx
  on workflows (status, updated_at);
create index workflows_deadline_idx
  on workflows (deadline_at)
  where status in ('queued', 'running', 'awaiting_approval', 'reconciling', 'unknown');
create index workflows_thread_created_idx
  on workflows (organization_id, thread_id, created_at);
create index workflows_root_bot_created_idx
  on workflows (organization_id, root_bot_id, created_at)
  where root_bot_id is not null;
-- L'historique des exécutions liste les workflows d'une ORGANISATION en
-- pagination par clé.
create index workflows_organization_created_idx
  on workflows (organization_id, created_at desc, id desc);

alter table runs
  add constraint runs_workflow_fkey
    foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete set null (workflow_id);

create unique index runs_workflow_step_idx
  on runs (organization_id, workflow_id, step_index)
  where workflow_id is not null and step_index is not null;
create index runs_execution_session_key_idx
  on runs (organization_id, execution_session_key, created_at)
  where execution_session_key is not null;
create index runs_workflow_created_idx
  on runs (organization_id, workflow_id, created_at)
  where workflow_id is not null;

-- `run_events` est le buffer de livraison SSE, pas un transcript indéfini :
-- le worker applique une rétention par défaut de 30 jours
-- (WORKER_RUN_EVENTS_RETENTION_DAYS) aux runs terminés et ne touche jamais
-- aux runs vivants, pour qu'un curseur actif ne perde pas sa queue.
create table run_events (
  cursor bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  run_id uuid not null,
  sequence integer not null,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, run_id, sequence),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references runs(organization_id, id) on delete cascade
);
create index run_events_tenant_cursor_idx on run_events (organization_id, cursor);
-- Le roster relit la dernière activité runtime par fil ; évite un parcours
-- global de run_events à chaque rafraîchissement de la sidebar.
create index run_events_thread_occurred_idx
  on run_events (organization_id, thread_id, occurred_at desc);

create or replace function notify_ohb_event() returns trigger language plpgsql as $$
begin
  perform pg_notify('ohb_events', new.organization_id::text || ':' || new.cursor::text);
  return new;
end;
$$;
create trigger run_events_notify after insert on run_events
for each row execute function notify_ohb_event();

-- Un follow-up reste un workflow ordinaire en file tant qu'Hermes n'a pas
-- confirmé son injection dans le run actif. Cet outbox durable est la
-- frontière entre les deux effets : un crash ne peut pas à la fois rejouer le
-- POST /steer et exécuter plus tard le workflow de repli en silence.
create table run_steering_attempts (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  target_run_id uuid not null,
  source_run_id uuid not null,
  text text not null check (char_length(text) between 1 and 65536),
  status text not null default 'pending' check (status in (
    'pending', 'sending', 'confirmed', 'unsupported', 'rejected', 'ambiguous', 'expired'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  forwarding_owner text,
  forwarding_epoch bigint not null default 0 check (forwarding_epoch >= 0),
  forwarding_lease_expires_at timestamptz,
  response_status integer,
  error_code text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, source_run_id),
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, target_run_id)
    references runs(organization_id, id) on delete cascade,
  foreign key (organization_id, source_run_id)
    references runs(organization_id, id) on delete cascade,
  check (target_run_id <> source_run_id),
  check (
    (status = 'sending' and forwarding_owner is not null and forwarding_lease_expires_at is not null)
    or
    (status <> 'sending' and forwarding_owner is null and forwarding_lease_expires_at is null)
  ),
  check ((status = 'confirmed') = (delivered_at is not null))
);

create index run_steering_target_pending_idx
  on run_steering_attempts (organization_id, target_run_id, available_at, created_at, id)
  where status in ('pending', 'sending');
create index run_steering_source_ambiguous_idx
  on run_steering_attempts (organization_id, source_run_id)
  where status = 'ambiguous';

-- Réservation durable pour POST /threads/:threadId/messages. Les ids et clés
-- d'objets sont alloués une seule fois, avant tout I/O blob : une réponse
-- HTTP perdue se rejoue sans créer un second message, run, workflow ou
-- attachment.
create table message_ingress (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  thread_id uuid not null,
  operation text not null,
  idempotency_key uuid not null,
  request_hash text not null,
  message_id uuid not null,
  run_id uuid not null,
  workflow_id uuid,
  attachment_manifest jsonb not null default '[]'::jsonb,
  response_status integer,
  response_body jsonb,
  state text not null default 'reserved'
    check (state in ('reserved', 'completed', 'abandoned')),
  reservation_owner text,
  reservation_lease_expires_at timestamptz,
  reservation_epoch bigint not null default 0 check (reservation_epoch >= 0),
  expires_at timestamptz not null default (now() + interval '7 days'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id, operation, idempotency_key),
  unique (organization_id, message_id),
  unique (organization_id, run_id),
  unique (organization_id, workflow_id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade,
  check (length(operation) between 1 and 64),
  check (request_hash ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(attachment_manifest) = 'array'),
  check (response_status is null or response_status between 100 and 599),
  check (response_body is null or jsonb_typeof(response_body) = 'object')
);

create index message_ingress_reservations_idx
  on message_ingress (reservation_lease_expires_at, created_at)
  where state = 'reserved';
create index message_ingress_expiry_idx
  on message_ingress (expires_at);

alter table runs enable row level security;
alter table runs force row level security;
alter table workflows enable row level security;
alter table workflows force row level security;
alter table run_events enable row level security;
alter table run_events force row level security;
alter table run_steering_attempts enable row level security;
alter table run_steering_attempts force row level security;
alter table message_ingress enable row level security;
alter table message_ingress force row level security;

create policy runs_tenant on runs to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runs_worker on runs to ohb_worker using (true) with check (true);

create policy workflows_tenant on workflows to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy workflows_worker on workflows to ohb_worker using (true) with check (true);

create policy run_events_tenant on run_events to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy run_events_worker on run_events to ohb_worker using (true) with check (true);

create policy run_steering_attempts_api on run_steering_attempts to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy run_steering_attempts_worker on run_steering_attempts to ohb_worker
  using (true) with check (true);

create policy message_ingress_tenant on message_ingress to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy message_ingress_worker on message_ingress to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on runs, run_events to ohb_api;
grant select, insert, update, delete on runs, run_events to ohb_worker;
grant select, insert, update, delete on workflows to ohb_api;
grant select, insert, update, delete on workflows to ohb_worker;
grant select, insert, update, delete on run_steering_attempts to ohb_api;
grant select, insert, update, delete on run_steering_attempts to ohb_worker;
grant select, insert, update, delete on message_ingress to ohb_api;
grant select, insert, update, delete on message_ingress to ohb_worker;
grant usage, select on sequence run_events_cursor_seq to ohb_api;
grant usage, select on sequence run_events_cursor_seq to ohb_worker;

insert into schema_migrations(version) values ('0005_runs_workflows')
on conflict (version) do nothing;

commit;
