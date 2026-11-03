begin;

-- OHB-56 : audit de création scellé, preuve de possession du lien, journal de
-- dispatch et verdicts signés.
--
-- Quatre tables et deux colonnes, toutes additives. Les clés d'audit sont
-- chiffrées par le keyring `RUNTIME_TOKEN_ENCRYPTION_KEY` (même quadruplet que
-- les bearers des runtimes : ciphertext / nonce / tag / key id) ; les ancres
-- et les dispatches sont des métadonnées ; les verdicts ne portent ni
-- événement déchiffré ni clé. Les politiques RLS admettent DEUX contextes
-- côté `ohb_api` : le tenant (`app.organization_id`, routes de session) et le
-- credential du lien (`app.session_credential_hash`, écritures du broker à la
-- liaison : même porte que `runtimes` depuis 0027).

-- ─── Le lien : clé device et échéance du jeton ───────────────────────────────

alter table runtimes
  add column link_device_pubkey text
    constraint runtimes_link_device_pubkey_check check (link_device_pubkey ~ '^[A-Za-z0-9+/]{43}=$'),
  add column link_token_expires_at timestamptz;

comment on column runtimes.link_device_pubkey is
  'Clé publique Ed25519 (base64, 32 octets) de la machine enrôlée. Présente, une session du lien n''est liée qu''après link.challenge / link.proof ; un jeton volé seul n''ouvre rien.';
comment on column runtimes.link_token_expires_at is
  'Échéance informative du jeton de lien courant, posée par la rotation automatique du worker (LINK_TOKEN_MAX_AGE_HOURS). Jamais lue pour refuser une montée : la rotation elle-même remplace le hash.';

alter table runtime_link_events drop constraint runtime_link_events_kind_check;
alter table runtime_link_events add constraint runtime_link_events_kind_check
  check (kind in (
    'connected', 'replaced', 'disconnected', 'revoked', 'rotated', 'hijack_suspected',
    'pop_failed', 'pop_missing', 'unattributed_session', 'clock_skew'
  ));

comment on constraint runtime_link_events_kind_check on runtime_link_events is
  'pop_failed : preuve de possession refusée (4401). pop_missing : runtime sans clé device lié hors production. unattributed_session : session Hermes inconnue d''OHB relevée par la réconciliation. clock_skew : horloge du connecteur en désaccord avec les dispatches de l''API.';

-- ─── Clés maîtresses d'audit ────────────────────────────────────────────────

create table runtime_audit_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  key_id text not null check (key_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
  ciphertext text not null,
  nonce text not null,
  tag text not null,
  key_encryption_key_id text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (runtime_id, key_id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);

-- Une seule clé courante par runtime ; les clés retirées restent pour ouvrir
-- les exports scellés avant la rotation.
create unique index runtime_audit_keys_current_idx on runtime_audit_keys (runtime_id) where retired_at is null;

comment on table runtime_audit_keys is
  'Clé maîtresse de l''audit de création par runtime, chiffrée par le keyring des bearers. Remise au connecteur à chaque session (audit.key), jamais écrite sur le VPS. Une clé retirée n''est jamais purgée tant que le runtime existe : les exports scellés sous elle restent vérifiables.';

alter table runtime_audit_keys enable row level security;
alter table runtime_audit_keys force row level security;
create policy runtime_audit_keys_api on runtime_audit_keys to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_audit_keys.runtime_id and r.organization_id = runtime_audit_keys.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_audit_keys.runtime_id and r.organization_id = runtime_audit_keys.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  );
grant select, insert, update on runtime_audit_keys to ohb_api;

-- ─── Ancres : la position courante de la chaîne, par runtime ────────────────

create table runtime_audit_anchors (
  runtime_id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  key_id text not null check (key_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
  write_seq bigint not null check (write_seq >= 0),
  event_count integer not null check (event_count >= 0),
  dropped bigint not null check (dropped >= 0),
  tail text not null check (tail ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);

comment on table runtime_audit_anchors is
  'Dernière ancre audit.anchor reçue par runtime : writeSeq, compteurs et tail de la chaîne. Un export en retrait de l''ancre est une copie antérieure, pas l''audit courant — ce que ni le chiffrement ni la chaîne seuls ne détectent.';

alter table runtime_audit_anchors enable row level security;
alter table runtime_audit_anchors force row level security;
create policy runtime_audit_anchors_api on runtime_audit_anchors to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_audit_anchors.runtime_id and r.organization_id = runtime_audit_anchors.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_audit_anchors.runtime_id and r.organization_id = runtime_audit_anchors.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  );
grant select, insert, update on runtime_audit_anchors to ohb_api;

-- ─── Journal de dispatch : ce que l'API a elle-même relayé ──────────────────

create table runtime_link_dispatches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  instance_id text not null,
  generation bigint check (generation > 0),
  idempotency_key_hash text check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  dispatched_at timestamptz not null default now(),
  status integer check (status between 100 and 599),
  remote_id text check (remote_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);

create index runtime_link_dispatches_hash_idx on runtime_link_dispatches (runtime_id, idempotency_key_hash);
create index runtime_link_dispatches_recent_idx on runtime_link_dispatches (organization_id, runtime_id, dispatched_at desc);

comment on table runtime_link_dispatches is
  'Un enregistrement par POST /v1/runs relayé par le broker vers un runtime connector : le SHA-256 de l''Idempotency-Key, l''instant, le statut et le run_id distant lu sur la réponse bornée. Jumeau côté API de l''audit du connecteur : un événement d''audit sans dispatch ici est une invention.';

alter table runtime_link_dispatches enable row level security;
alter table runtime_link_dispatches force row level security;
create policy runtime_link_dispatches_api on runtime_link_dispatches to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_link_dispatches.runtime_id and r.organization_id = runtime_link_dispatches.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or exists (
      select 1 from runtimes r
       where r.id = runtime_link_dispatches.runtime_id and r.organization_id = runtime_link_dispatches.organization_id
         and (r.link_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
           or (r.link_token_previous_hash = nullif(current_setting('app.session_credential_hash', true), '')
               and r.link_token_previous_expires_at > now()))
    )
  );
grant select, insert on runtime_link_dispatches to ohb_api;

-- ─── Verdicts de vérification ───────────────────────────────────────────────

create table runtime_audit_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  export_sha256 text not null check (export_sha256 ~ '^[0-9a-f]{64}$'),
  key_id text check (key_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
  verdict text not null check (verdict in ('valid', 'valid_unanchored', 'invalid')),
  error_code text check (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  anchor_state text not null check (anchor_state in ('matches', 'behind', 'none', 'stale', 'db_only')),
  write_seq bigint check (write_seq >= 0),
  event_count integer check (event_count >= 0),
  dropped bigint check (dropped >= 0),
  tail text check (tail ~ '^[0-9a-f]{64}$'),
  started_at timestamptz,
  last_written_at timestamptz,
  findings jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  signature text,
  signature_key_id text,
  received_at timestamptz not null default now(),
  verified_by uuid references users(id) on delete set null,
  unique (runtime_id, export_sha256),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);

create index runtime_audit_verifications_recent_idx
  on runtime_audit_verifications (organization_id, runtime_id, received_at desc, id desc);

comment on table runtime_audit_verifications is
  'Verdict daté et signé de la vérification d''un export d''audit de création : résumé seulement (compteurs, tail, fenêtre, état de l''ancre, code d''erreur, constats bornés), jamais les événements déchiffrés ni la clé. Idempotent par (runtime, SHA-256 de l''export). Rétention : au moins un an, comme le reste du journal d''audit ; aucun purgeur ne la raccourcit.';

alter table runtime_audit_verifications enable row level security;
alter table runtime_audit_verifications force row level security;
create policy runtime_audit_verifications_tenant on runtime_audit_verifications to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert on runtime_audit_verifications to ohb_api;

-- Le worker : rotation automatique du jeton et réconciliation des sessions.
-- Il lit les runtimes et écrit le journal du lien comme avant (0027) ; il n'a
-- rien à faire des clés, des ancres ni des verdicts.
create policy runtime_link_dispatches_worker on runtime_link_dispatches to ohb_worker using (true) with check (true);
grant select on runtime_link_dispatches to ohb_worker;

-- ─── La vue audit_log gagne une cinquième source ────────────────────────────

create or replace view audit_log
with (security_invoker = true)
as
  select
    coalesce(c.claimed_at, c.created_at) as occurred_at,
    c.organization_id                     as organization_id,
    'staff_impersonation'::text           as source,
    case when c.claimed_at is not null
      then 'staff_impersonation.claimed'
      else 'staff_impersonation.issued'
    end::text                             as action,
    'staff'::text                         as actor_kind,
    c.staff_user_id                       as actor_id,
    'user'::text                          as subject_kind,
    c.user_id                             as subject_id,
    jsonb_build_object(
      'claimId', c.id,
      'issuedAt', c.created_at,
      'expiresAt', c.expires_at,
      'claimedAt', c.claimed_at,
      'sessionId', c.session_id
    )                                     as details
  from public.staff_impersonation_claims c

  union all

  select
    e.occurred_at,
    e.organization_id,
    'runtime_link'::text,
    ('runtime_link.' || e.kind)::text,
    'system'::text,
    null::uuid,
    'runtime'::text,
    e.runtime_id,
    jsonb_build_object(
      'eventId', e.id,
      'kind', e.kind,
      'ip', e.ip,
      'agent', e.agent,
      'previousIp', e.previous_ip
    )
  from public.runtime_link_events e

  union all

  select
    d.created_at,
    d.organization_id,
    'decision'::text,
    ('decision.' || d.choice)::text,
    case when d.actor_user_id is not null then 'user' else 'system' end::text,
    d.actor_user_id,
    'run'::text,
    d.run_id,
    jsonb_build_object(
      'decisionId', d.id,
      'choice', d.choice,
      'threadId', d.thread_id,
      'runId', d.run_id,
      'approvalRequestId', d.approval_request_id,
      'chainSequence', d.chain_sequence
    )
  from public.decisions d

  union all

  select
    w.created_at,
    w.organization_id,
    'webhook_management'::text,
    w.operation::text,
    'user'::text,
    w.user_id,
    'webhook_endpoint'::text,
    w.endpoint_id,
    jsonb_build_object(
      'operationId', w.id,
      'operation', w.operation,
      'idempotencyKey', w.idempotency_key,
      'recoverableUntil', w.recoverable_until
    )
  from public.webhook_management_operations w

  union all

  -- Verdicts d'audit de création (0052). `details` porte le résumé : verdict,
  -- code d'erreur, état de l'ancre, compteurs, SHA-256 de l'export. Jamais un
  -- événement déchiffré, jamais une clé.
  select
    v.received_at,
    v.organization_id,
    'creation_audit'::text,
    ('creation_audit.' || v.verdict)::text,
    'user'::text,
    v.verified_by,
    'runtime'::text,
    v.runtime_id,
    jsonb_build_object(
      'verificationId', v.id,
      'verdict', v.verdict,
      'errorCode', v.error_code,
      'anchorState', v.anchor_state,
      'exportSha256', v.export_sha256,
      'keyId', v.key_id,
      'writeSeq', v.write_seq,
      'eventCount', v.event_count,
      'dropped', v.dropped
    )
  from public.runtime_audit_verifications v;

comment on view audit_log is
  'Journal d''audit unifié : vue de lecture normalisée par-dessus les cinq journaux existants (assistance staff, lien connecteur, décisions d''approbation, management des webhooks, verdicts d''audit de création). Elle est lue par les ADMINS DU TENANT — `security_invoker` fait appliquer la RLS de chaque table sous-jacente à l''appelant, donc une organisation ne voit que ses propres lignes — ET par le STAFF, tous tenants confondus, via `staff_audit_log()`. Point de conception : la rétention d''un journal d''audit est LONGUE (au moins un an), volontairement distincte de la purge analytique à 90 jours de `analytics_events` ; ce ne sont pas les mêmes obligations, et la vue n''ajoute aucune rétention propre — elle hérite de celle de ses sources, qu''aucun purgeur ne doit raccourcir. Aucune donnée personnelle ni aucun secret ne transite : ni e-mail, ni contenu de message, ni jeton, ni condensat de credential, ni clé d''audit.';

grant select on audit_log to ohb_api;

insert into schema_migrations(version) values ('0052_runtime_audit') on conflict (version) do nothing;
commit;
