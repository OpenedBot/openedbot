-- Baseline 3 of 10, generated from the schema of migrations 0001 to 0192.
-- Tables, the audit_log view and the sequences.

BEGIN;

-- table: account_deletions
CREATE TABLE public.account_deletions (
    user_id uuid NOT NULL,
    organization_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    last_error text,
    last_attempt_at timestamp with time zone
);

ALTER TABLE ONLY public.account_deletions FORCE ROW LEVEL SECURITY;

-- table: alert_channels
CREATE TABLE public.alert_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    target_hint text NOT NULL,
    target_hash text NOT NULL,
    secret_ciphertext text NOT NULL,
    secret_nonce text NOT NULL,
    secret_tag text NOT NULL,
    secret_key_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    last_delivered_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_failure_status integer,
    last_failure_reason text,
    last_test_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_channels_check CHECK (((last_failure_at IS NULL) = (last_failure_reason IS NULL))),
    CONSTRAINT alert_channels_kind_check CHECK ((kind = 'discord'::text)),
    CONSTRAINT alert_channels_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80))),
    CONSTRAINT alert_channels_last_failure_reason_check CHECK (((last_failure_reason IS NULL) OR (last_failure_reason = ANY (ARRAY['webhook_revoked'::text, 'rejected'::text, 'rate_limited'::text, 'unreachable'::text, 'decryption_failed'::text])))),
    CONSTRAINT alert_channels_last_failure_status_check CHECK (((last_failure_status IS NULL) OR ((last_failure_status >= 100) AND (last_failure_status <= 599)))),
    CONSTRAINT alert_channels_target_hash_check CHECK ((target_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT alert_channels_target_hint_check CHECK (((length(target_hint) >= 1) AND (length(target_hint) <= 200)))
);

ALTER TABLE ONLY public.alert_channels FORCE ROW LEVEL SECURITY;

-- comment: TABLE alert_channels
COMMENT ON TABLE public.alert_channels IS 'Canaux d''alerte d''une organisation (Discord) : URL de webhook chiffrée, jamais rendue ; aperçu et hash pour les doublons. Le worker y relit le secret sous le tenant de la livraison.';

-- table: alert_deliveries
CREATE TABLE public.alert_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    alert_id uuid NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_http_status integer,
    last_reason text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_deliveries_attempts_check CHECK (((attempts >= 0) AND (attempts <= 20))),
    CONSTRAINT alert_deliveries_event_check CHECK ((event = ANY (ARRAY['runtime_link_down'::text, 'runtime_link_restored'::text]))),
    CONSTRAINT alert_deliveries_last_http_status_check CHECK (((last_http_status IS NULL) OR ((last_http_status >= 100) AND (last_http_status <= 599)))),
    CONSTRAINT alert_deliveries_last_reason_check CHECK (((last_reason IS NULL) OR (last_reason ~ '^[a-z_]{1,64}$'::text))),
    CONSTRAINT alert_deliveries_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT alert_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.alert_deliveries FORCE ROW LEVEL SECURITY;

-- comment: TABLE alert_deliveries
COMMENT ON TABLE public.alert_deliveries IS 'Livraisons des alertes de lien vers les canaux (Discord) : une par (canal, alerte, événement). Retente 429/5xx avec recul borné, puis failed ; 401/403/404 désactivent le canal.';

-- table: api_errors
CREATE TABLE public.api_errors (
    reference uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    organization_id uuid,
    user_id uuid,
    method text NOT NULL,
    route text,
    path text NOT NULL,
    error_code text NOT NULL,
    pg_code text,
    cause text NOT NULL,
    message text NOT NULL,
    stack text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_errors_cause_bounded CHECK ((length(cause) <= 256)),
    CONSTRAINT api_errors_code_bounded CHECK ((length(error_code) <= 64)),
    CONSTRAINT api_errors_message_bounded CHECK ((length(message) <= 1024)),
    CONSTRAINT api_errors_method_bounded CHECK ((length(method) <= 16)),
    CONSTRAINT api_errors_path_bounded CHECK ((length(path) <= 512)),
    CONSTRAINT api_errors_pg_code_shape CHECK (((pg_code IS NULL) OR (pg_code ~ '^[0-9A-Z]{5}$'::text))),
    CONSTRAINT api_errors_route_bounded CHECK (((route IS NULL) OR (length(route) <= 512))),
    CONSTRAINT api_errors_stack_bounded CHECK (((stack IS NULL) OR (length(stack) <= 8192)))
);

ALTER TABLE ONLY public.api_errors FORCE ROW LEVEL SECURITY;

-- comment: TABLE api_errors
COMMENT ON TABLE public.api_errors IS 'Erreurs non prévues de l''API (500 INTERNAL_ERROR), une ligne par référence affichée à l''utilisateur. Écriture asynchrone best-effort par openedbot_api (insert seul). Ni corps, ni en-têtes, ni query string ; message et pile rédigés et bornés. Le worker purge au-delà de 90 jours (policy api_errors_worker_*). Lecture : select * from api_errors where reference = ''<référence>''.';

-- table: api_instances
CREATE TABLE public.api_instances (
    instance_id text NOT NULL,
    internal_url text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    CONSTRAINT api_instances_internal_url_check CHECK (((char_length(internal_url) >= 8) AND (char_length(internal_url) <= 2048)))
);

-- comment: TABLE api_instances
COMMENT ON TABLE public.api_instances IS 'Répliques API vivantes. Table d''exploitation hors RLS : instance_id (celui posé dans runtimes.link_instance_id), URL interne joignable par les autres répliques, heartbeat. Une ligne sans heartbeat depuis 60 s, ou avec stopped_at, est morte. openedbot_api écrit, openedbot_worker lit.';

-- comment: COLUMN api_instances.instance_id
COMMENT ON COLUMN public.api_instances.instance_id IS 'Identifiant de processus API, le même que runtimes.link_instance_id.';

-- comment: COLUMN api_instances.internal_url
COMMENT ON COLUMN public.api_instances.internal_url IS 'Origine interne de CETTE réplique (API_INTERNAL_URL), joignable par les autres répliques et par le worker. Pas l''URL publique.';

-- comment: COLUMN api_instances.started_at
COMMENT ON COLUMN public.api_instances.started_at IS 'Démarrage de cette instance ; reposé à chaque réenregistrement.';

-- comment: COLUMN api_instances.last_seen_at
COMMENT ON COLUMN public.api_instances.last_seen_at IS 'Dernier heartbeat (toutes les 15 s). Au-delà de 60 s sans signe de vie, l''instance est morte.';

-- comment: COLUMN api_instances.stopped_at
COMMENT ON COLUMN public.api_instances.stopped_at IS 'Arrêt propre (SIGINT/SIGTERM, après closeAll 1001 du broker). NULL tant que le processus tourne ou s''il a crashé.';

-- table: apns_deliveries
CREATE TABLE public.apns_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    outbox_id uuid NOT NULL,
    device_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_http_status integer,
    last_reason text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apns_deliveries_attempts_check CHECK (((attempts >= 0) AND (attempts <= 20))),
    CONSTRAINT apns_deliveries_last_http_status_check CHECK (((last_http_status IS NULL) OR ((last_http_status >= 100) AND (last_http_status <= 599)))),
    CONSTRAINT apns_deliveries_last_reason_check CHECK (((last_reason IS NULL) OR (last_reason ~ '^[A-Za-z]{1,64}$'::text))),
    CONSTRAINT apns_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.apns_deliveries FORCE ROW LEVEL SECURITY;

-- comment: TABLE apns_deliveries
COMMENT ON TABLE public.apns_deliveries IS 'Fan-out APNs de push_outbox : une livraison par (outbox, appareil), apns-id = id. Retente 429/5xx avec backoff borne, puis failed. Aucun token, aucun texte de fil.';

-- table: apns_devices
CREATE TABLE public.apns_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    installation_id text NOT NULL,
    bundle_id text NOT NULL,
    environment text NOT NULL,
    token_hash text NOT NULL,
    token_ciphertext text,
    token_nonce text,
    token_tag text,
    token_key_id text,
    last_registered_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sent_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apns_devices_bundle_id_check CHECK ((bundle_id ~ '^[A-Za-z0-9.-]{3,255}$'::text)),
    CONSTRAINT apns_devices_check CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL))),
    CONSTRAINT apns_devices_check1 CHECK ((((revoked_at IS NULL) AND (token_ciphertext IS NOT NULL) AND (token_nonce IS NOT NULL) AND (token_tag IS NOT NULL) AND (token_key_id IS NOT NULL)) OR ((revoked_at IS NOT NULL) AND (token_ciphertext IS NULL) AND (token_nonce IS NULL) AND (token_tag IS NULL) AND (token_key_id IS NULL)))),
    CONSTRAINT apns_devices_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT apns_devices_installation_id_check CHECK ((installation_id ~ '^[A-Za-z0-9._-]{1,128}$'::text)),
    CONSTRAINT apns_devices_revoked_reason_check CHECK ((revoked_reason = ANY (ARRAY['token_moved'::text, 'unregistered'::text, 'bad_device_token'::text, 'device_token_not_for_topic'::text]))),
    CONSTRAINT apns_devices_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.apns_devices FORCE ROW LEVEL SECURITY;

-- comment: TABLE apns_devices
COMMENT ON TABLE public.apns_devices IS 'Appareils iOS (APNs) par membre et installation. Token chiffre, SHA-256 pour les collisions, jamais rendu. Revoque (secret efface) sur collision, 410 ou BadDeviceToken ; supprime au logout natif, au DELETE et au depart du membre.';

-- table: approval_requests
CREATE TABLE public.approval_requests (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    command text,
    description text,
    choices jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    selected_choice text,
    forwarded_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    gate_ordinal integer DEFAULT 0 NOT NULL,
    forward_state text DEFAULT 'pending'::text NOT NULL,
    forwarding_owner text,
    forwarding_lease_expires_at timestamp with time zone,
    forwarding_epoch bigint DEFAULT 0 NOT NULL,
    decision_id uuid,
    resolved_by_policy text,
    hermes_request_id text,
    gate_kind text DEFAULT 'unknown'::text NOT NULL,
    tool_key text,
    gate_args jsonb,
    descriptor_version smallint,
    decision_state text,
    decision_stage text,
    decided_by_kind text,
    permission_revision_seen bigint,
    decision_detail jsonb,
    decision_claim_token uuid,
    decision_lease_expires_at timestamp with time zone,
    hermes_execution_generation bigint,
    CONSTRAINT approval_requests_decided_by_kind_check CHECK (((decided_by_kind IS NULL) OR (decided_by_kind = ANY (ARRAY['member'::text, 'policy'::text])))),
    CONSTRAINT approval_requests_decision_detail_check CHECK (((decision_detail IS NULL) OR ((jsonb_typeof(decision_detail) = 'object'::text) AND (octet_length((decision_detail)::text) <= 2048)))),
    CONSTRAINT approval_requests_decision_stage_check CHECK (((decision_stage IS NULL) OR (decision_stage = ANY (ARRAY['forbidden'::text, 'floor'::text, 'opaque'::text, 'deletion'::text, 'tool_policy'::text, 'grant'::text, 'review'::text, 'full'::text, 'human'::text, 'unattended'::text])))),
    CONSTRAINT approval_requests_decision_state_check CHECK (((decision_state IS NULL) OR (decision_state = ANY (ARRAY['reviewing'::text, 'awaiting_human'::text, 'decided'::text])))),
    CONSTRAINT approval_requests_descriptor_version_check CHECK (((descriptor_version IS NULL) OR (descriptor_version >= 1))),
    CONSTRAINT approval_requests_forward_state_check CHECK ((forward_state = ANY (ARRAY['pending'::text, 'ready'::text, 'sending'::text, 'confirmed'::text, 'ambiguous'::text, 'expired'::text]))),
    CONSTRAINT approval_requests_forwarding_epoch_nonnegative CHECK ((forwarding_epoch >= 0)),
    CONSTRAINT approval_requests_gate_args_check CHECK (((gate_args IS NULL) OR ((jsonb_typeof(gate_args) = 'object'::text) AND (octet_length((gate_args)::text) <= 8192)))),
    CONSTRAINT approval_requests_gate_identity_shape_check CHECK ((((gate_kind = 'plugin_tool'::text) AND (tool_key IS NOT NULL) AND (descriptor_version IS NOT NULL) AND (gate_args IS NOT NULL)) OR ((gate_kind = 'terminal_danger'::text) AND (tool_key IS NULL) AND (descriptor_version IS NULL) AND (gate_args IS NOT NULL)) OR ((gate_kind = 'unknown'::text) AND (tool_key IS NULL) AND (descriptor_version IS NULL) AND (gate_args IS NULL)))),
    CONSTRAINT approval_requests_gate_kind_check CHECK ((gate_kind = ANY (ARRAY['plugin_tool'::text, 'terminal_danger'::text, 'unknown'::text]))),
    CONSTRAINT approval_requests_gate_ordinal_nonnegative CHECK ((gate_ordinal >= 0)),
    CONSTRAINT approval_requests_hermes_execution_generation_check CHECK (((hermes_execution_generation IS NULL) OR (hermes_execution_generation >= 0))),
    CONSTRAINT approval_requests_hermes_request_id_check CHECK (((hermes_request_id IS NULL) OR (((length(hermes_request_id) >= 1) AND (length(hermes_request_id) <= 256)) AND (hermes_request_id = btrim(hermes_request_id))))),
    CONSTRAINT approval_requests_permission_revision_seen_check CHECK (((permission_revision_seen IS NULL) OR (permission_revision_seen >= 0))),
    CONSTRAINT approval_requests_policy_has_no_user CHECK (((resolved_by_policy IS NULL) OR (resolved_by IS NULL))),
    CONSTRAINT approval_requests_resolved_by_policy_check CHECK (((resolved_by_policy IS NULL) OR (resolved_by_policy = ANY (ARRAY['auto'::text, 'bypass'::text, 'manual'::text, 'plan'::text])))),
    CONSTRAINT approval_requests_review_claim_check CHECK (((decision_claim_token IS NULL) = (decision_lease_expires_at IS NULL))),
    CONSTRAINT approval_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text]))),
    CONSTRAINT approval_requests_tool_key_check CHECK (((tool_key IS NULL) OR (tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'::text)))
);

ALTER TABLE ONLY public.approval_requests FORCE ROW LEVEL SECURITY;

-- table: attachments
CREATE TABLE public.attachments (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    message_id uuid,
    object_key text NOT NULL,
    driver text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    kind text NOT NULL,
    bytes integer NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_bytes_check CHECK (((bytes >= 1) AND (bytes <= 1048576))),
    CONSTRAINT attachments_driver_check CHECK ((driver = ANY (ARRAY['file'::text, 'r2'::text]))),
    CONSTRAINT attachments_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'document'::text])))
);

ALTER TABLE ONLY public.attachments FORCE ROW LEVEL SECURITY;

-- table: audit_chain
CREATE TABLE public.audit_chain (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    seq bigint NOT NULL,
    kind text NOT NULL,
    object_key text NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 text NOT NULL,
    prev_hash text,
    hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_chain_check CHECK (((seq = 1) = (prev_hash IS NULL))),
    CONSTRAINT audit_chain_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT audit_chain_kind_check CHECK ((kind = ANY (ARRAY['runtime_anchor'::text, 'audit_verdict'::text]))),
    CONSTRAINT audit_chain_object_key_check CHECK (((char_length(object_key) >= 1) AND (char_length(object_key) <= 256))),
    CONSTRAINT audit_chain_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT audit_chain_payload_sha256_check CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT audit_chain_prev_hash_check CHECK ((prev_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT audit_chain_seq_check CHECK ((seq >= 1))
);

ALTER TABLE ONLY public.audit_chain FORCE ROW LEVEL SECURITY;

-- comment: TABLE audit_chain
COMMENT ON TABLE public.audit_chain IS 'Local hash chain of the creation audit, one chain per runtime: each received anchor (runtime_anchor) and each verdict (audit_verdict), appended in the business transaction. Append-only; verified by GET /api/runtimes/:id/creation-audit/local-chain. Goes with its organization only.';

-- comment: COLUMN audit_chain.hash
COMMENT ON COLUMN public.audit_chain.hash IS 'sha256 of the canonical JSON {v: 1, seq, prev, kind, payloadSha256}: identifiers are not hashed directly, so pseudonymized archives still verify.';

-- table: decisions
CREATE TABLE public.decisions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid,
    run_id uuid,
    approval_request_id uuid,
    actor_user_id uuid,
    choice text NOT NULL,
    envelope jsonb NOT NULL,
    previous_hash text,
    entry_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chain_sequence bigint NOT NULL
);

ALTER TABLE ONLY public.decisions FORCE ROW LEVEL SECURITY;

-- comment: COLUMN decisions.thread_id
COMMENT ON COLUMN public.decisions.thread_id IS 'Nullable live pointer; the signed envelope retains the historical thread identifier.';

-- comment: COLUMN decisions.run_id
COMMENT ON COLUMN public.decisions.run_id IS 'Nullable live pointer; the signed envelope retains the historical run identifier.';

-- comment: COLUMN decisions.approval_request_id
COMMENT ON COLUMN public.decisions.approval_request_id IS 'Nullable live pointer; the signed envelope retains the historical approval identifier.';

-- table: runtime_audit_verifications
CREATE TABLE public.runtime_audit_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    export_sha256 text NOT NULL,
    key_id text,
    verdict text NOT NULL,
    error_code text,
    anchor_state text NOT NULL,
    write_seq bigint,
    event_count integer,
    dropped bigint,
    tail text,
    started_at timestamp with time zone,
    last_written_at timestamp with time zone,
    findings jsonb DEFAULT '[]'::jsonb NOT NULL,
    signature text,
    signature_key_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_by uuid,
    worm_state text DEFAULT 'disabled'::text NOT NULL,
    CONSTRAINT runtime_audit_verifications_anchor_state_check CHECK ((anchor_state = ANY (ARRAY['matches'::text, 'behind'::text, 'none'::text, 'stale'::text, 'db_only'::text]))),
    CONSTRAINT runtime_audit_verifications_dropped_check CHECK ((dropped >= 0)),
    CONSTRAINT runtime_audit_verifications_error_code_check CHECK ((error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'::text)),
    CONSTRAINT runtime_audit_verifications_event_count_check CHECK ((event_count >= 0)),
    CONSTRAINT runtime_audit_verifications_export_sha256_check CHECK ((export_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_audit_verifications_findings_check CHECK ((jsonb_typeof(findings) = 'array'::text)),
    CONSTRAINT runtime_audit_verifications_key_id_check CHECK ((key_id ~ '^[A-Za-z0-9._~-]{1,128}$'::text)),
    CONSTRAINT runtime_audit_verifications_tail_check CHECK ((tail ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_audit_verifications_verdict_check CHECK ((verdict = ANY (ARRAY['valid'::text, 'valid_unanchored'::text, 'invalid'::text]))),
    CONSTRAINT runtime_audit_verifications_worm_state_check CHECK ((worm_state = ANY (ARRAY['disabled'::text, 'missing'::text, 'matches'::text, 'tampered'::text]))),
    CONSTRAINT runtime_audit_verifications_write_seq_check CHECK ((write_seq >= 0))
);

ALTER TABLE ONLY public.runtime_audit_verifications FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_audit_verifications
COMMENT ON TABLE public.runtime_audit_verifications IS 'Verdict daté et signé de la vérification d''un export d''audit de création : résumé seulement (compteurs, tail, fenêtre, état de l''ancre, code d''erreur, constats bornés), jamais les événements déchiffrés ni la clé. Idempotent par (runtime, SHA-256 de l''export). Rétention : au moins un an, comme le reste du journal d''audit ; aucun purgeur ne la raccourcit.';

-- comment: COLUMN runtime_audit_verifications.worm_state
COMMENT ON COLUMN public.runtime_audit_verifications.worm_state IS 'Ce que le bucket WORM disait de l''export au moment du verdict : disabled (aucun store configuré), missing (aucune ancre archivée pour cette position), matches (l''ancre archivée décrit la même position que l''export et que la base), tampered (elle en décrit une autre ; le verdict est alors invalid, code AUDIT_ANCHOR_TAMPERED).';

-- table: runtime_link_events
CREATE TABLE public.runtime_link_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    kind text NOT NULL,
    ip text,
    agent text,
    previous_ip text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT runtime_link_events_kind_check CHECK ((kind = ANY (ARRAY['connected'::text, 'replaced'::text, 'disconnected'::text, 'revoked'::text, 'rotated'::text, 'hijack_suspected'::text, 'pop_failed'::text, 'pop_missing'::text, 'unattributed_session'::text, 'clock_skew'::text, 'worm_write_failed'::text, 'anchor_tampered'::text, 'device_key_registered'::text, 'agent_outdated'::text]))),
    CONSTRAINT runtime_link_events_meta_check CHECK ((jsonb_typeof(meta) = 'object'::text))
);

ALTER TABLE ONLY public.runtime_link_events FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_link_events
COMMENT ON TABLE public.runtime_link_events IS 'Journal du lien connecteur par runtime : connexions, remplacements, révocations, rotations, soupçons de détournement.';

-- comment: COLUMN runtime_link_events.meta
COMMENT ON COLUMN public.runtime_link_events.meta IS 'Connection instance/generation and close details. ownershipCurrent records fenced DB ownership at close: false for stale sockets, null if persistence failed; a disconnected event is not the current runtime state.';

-- comment: CONSTRAINT runtime_link_events_kind_check ON runtime_link_events
COMMENT ON CONSTRAINT runtime_link_events_kind_check ON public.runtime_link_events IS 'pop_failed : preuve de possession refusée (4401). pop_missing : runtime sans clé device lié hors production. unattributed_session : session Hermes inconnue d''openedbot relevée par la réconciliation. clock_skew : horloge du connecteur en désaccord avec les dispatches de l''API. worm_write_failed : une ancre ou un verdict n''a pas pu être déposé dans le bucket WORM (meta.reason = anchor | verdict). anchor_tampered : l''ancre archivée hors base ne décrit pas l''export vérifié ni l''ancre en base — la base ou l''export a été réécrit. device_key_registered : première clé device inscrite après preuve de possession sous le jeton courant (runtime enrôlé avant le PoP). agent_outdated : version stable du connecteur inférieure au minimum configuré (meta.minimum), sans refus de session.';

-- table: staff_impersonation_claims
CREATE TABLE public.staff_impersonation_claims (
    id uuid NOT NULL,
    staff_user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    claim_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_impersonation_claims_check CHECK (((claimed_at IS NOT NULL) OR (session_id IS NULL)))
);

ALTER TABLE ONLY public.staff_impersonation_claims FORCE ROW LEVEL SECURITY;

-- table: webhook_management_operations
CREATE TABLE public.webhook_management_operations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    operation text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    secret_ciphertext text,
    secret_nonce text,
    secret_tag text,
    secret_key_id text,
    recoverable_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_management_operations_check CHECK ((((secret_ciphertext IS NULL) AND (secret_nonce IS NULL) AND (secret_tag IS NULL) AND (secret_key_id IS NULL)) OR ((secret_ciphertext IS NOT NULL) AND (secret_nonce IS NOT NULL) AND (secret_tag IS NOT NULL) AND (secret_key_id IS NOT NULL)))),
    CONSTRAINT webhook_management_operations_operation_check CHECK ((operation = ANY (ARRAY['webhook.create'::text, 'webhook.rotate'::text]))),
    CONSTRAINT webhook_management_operations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.webhook_management_operations FORCE ROW LEVEL SECURITY;

-- view: audit_log
CREATE VIEW public.audit_log WITH (security_invoker='true') AS
 SELECT COALESCE(c.claimed_at, c.created_at) AS occurred_at,
    c.organization_id,
    'staff_impersonation'::text AS source,
        CASE
            WHEN (c.claimed_at IS NOT NULL) THEN 'staff_impersonation.claimed'::text
            ELSE 'staff_impersonation.issued'::text
        END AS action,
    'staff'::text AS actor_kind,
    c.staff_user_id AS actor_id,
    'user'::text AS subject_kind,
    c.user_id AS subject_id,
    jsonb_build_object('claimId', c.id, 'issuedAt', c.created_at, 'expiresAt', c.expires_at, 'claimedAt', c.claimed_at, 'sessionId', c.session_id) AS details
   FROM public.staff_impersonation_claims c
UNION ALL
 SELECT e.occurred_at,
    e.organization_id,
    'runtime_link'::text AS source,
    ('runtime_link.'::text || e.kind) AS action,
    'system'::text AS actor_kind,
    NULL::uuid AS actor_id,
    'runtime'::text AS subject_kind,
    e.runtime_id AS subject_id,
    jsonb_build_object('eventId', e.id, 'kind', e.kind, 'ip', e.ip, 'agent', e.agent, 'previousIp', e.previous_ip) AS details
   FROM public.runtime_link_events e
UNION ALL
 SELECT d.created_at AS occurred_at,
    d.organization_id,
    'decision'::text AS source,
    ('decision.'::text || d.choice) AS action,
        CASE
            WHEN (d.actor_user_id IS NOT NULL) THEN 'user'::text
            ELSE 'system'::text
        END AS actor_kind,
    d.actor_user_id AS actor_id,
    'run'::text AS subject_kind,
    d.run_id AS subject_id,
    jsonb_build_object('decisionId', d.id, 'choice', d.choice, 'threadId', d.thread_id, 'runId', d.run_id, 'approvalRequestId', d.approval_request_id, 'chainSequence', d.chain_sequence) AS details
   FROM public.decisions d
UNION ALL
 SELECT w.created_at AS occurred_at,
    w.organization_id,
    'webhook_management'::text AS source,
    w.operation AS action,
    'user'::text AS actor_kind,
    w.user_id AS actor_id,
    'webhook_endpoint'::text AS subject_kind,
    w.endpoint_id AS subject_id,
    jsonb_build_object('operationId', w.id, 'operation', w.operation, 'idempotencyKey', w.idempotency_key, 'recoverableUntil', w.recoverable_until) AS details
   FROM public.webhook_management_operations w
UNION ALL
 SELECT v.received_at AS occurred_at,
    v.organization_id,
    'creation_audit'::text AS source,
    ('creation_audit.'::text || v.verdict) AS action,
    'user'::text AS actor_kind,
    v.verified_by AS actor_id,
    'runtime'::text AS subject_kind,
    v.runtime_id AS subject_id,
    jsonb_build_object('verificationId', v.id, 'verdict', v.verdict, 'errorCode', v.error_code, 'anchorState', v.anchor_state, 'exportSha256', v.export_sha256, 'keyId', v.key_id, 'writeSeq', v.write_seq, 'eventCount', v.event_count, 'dropped', v.dropped) AS details
   FROM public.runtime_audit_verifications v;

-- comment: VIEW audit_log
COMMENT ON VIEW public.audit_log IS 'Journal d''audit unifié : vue de lecture normalisée par-dessus les cinq journaux existants (assistance staff, lien connecteur, décisions d''approbation, management des webhooks, verdicts d''audit de création). Elle est lue par les ADMINS DU TENANT — `security_invoker` fait appliquer la RLS de chaque table sous-jacente à l''appelant, donc une organisation ne voit que ses propres lignes — ET par le STAFF, tous tenants confondus, via `staff_audit_log()`. Point de conception : la rétention d''un journal d''audit est LONGUE (au moins un an), volontairement distincte de la purge analytique à 90 jours de `analytics_events` ; ce ne sont pas les mêmes obligations, et la vue n''ajoute aucune rétention propre — elle hérite de celle de ses sources, qu''aucun purgeur ne doit raccourcir. Aucune donnée personnelle ni aucun secret ne transite : ni e-mail, ni contenu de message, ni jeton, ni condensat de credential, ni clé d''audit.';

-- table: audit_worm_orphans
CREATE TABLE public.audit_worm_orphans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    kind text NOT NULL,
    object_key text NOT NULL,
    anchor_id text NOT NULL,
    written text NOT NULL,
    reason text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_worm_orphans_anchor_id_check CHECK (((char_length(anchor_id) >= 1) AND (char_length(anchor_id) <= 128))),
    CONSTRAINT audit_worm_orphans_kind_check CHECK ((kind = ANY (ARRAY['runtime_anchor'::text, 'audit_verdict'::text]))),
    CONSTRAINT audit_worm_orphans_object_key_check CHECK (((char_length(object_key) >= 1) AND (char_length(object_key) <= 256))),
    CONSTRAINT audit_worm_orphans_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 512))),
    CONSTRAINT audit_worm_orphans_written_check CHECK ((written = ANY (ARRAY['confirmed'::text, 'unknown'::text])))
);

ALTER TABLE ONLY public.audit_worm_orphans FORCE ROW LEVEL SECURITY;

-- comment: TABLE audit_worm_orphans
COMMENT ON TABLE public.audit_worm_orphans IS 'External anchor writes (WORM objects) whose business transaction rolled back: marked, never deleted. An orphan whose object key is later chained in audit_chain was retried successfully.';

-- table: bot_groups
CREATE TABLE public.bot_groups (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    section_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer NOT NULL,
    needs_you boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    default_responder jsonb DEFAULT '{"kind": "everyone"}'::jsonb NOT NULL,
    answer_mode text DEFAULT 'each'::text NOT NULL,
    pin_position integer,
    CONSTRAINT bot_groups_answer_mode_check CHECK ((answer_mode = ANY (ARRAY['each'::text, 'team'::text]))),
    CONSTRAINT bot_groups_default_responder_shape CHECK (((default_responder = '{"kind": "everyone"}'::jsonb) OR (default_responder = '{"kind": "mentions"}'::jsonb) OR (((default_responder ->> 'kind'::text) = 'member'::text) AND (jsonb_typeof((default_responder -> 'botId'::text)) = 'string'::text) AND (length((default_responder ->> 'botId'::text)) > 0) AND (default_responder = jsonb_build_object('kind', 'member', 'botId', (default_responder ->> 'botId'::text))))))
);

ALTER TABLE ONLY public.bot_groups FORCE ROW LEVEL SECURITY;

-- table: bot_host_cleanups
CREATE TABLE public.bot_host_cleanups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    bot_deleted_at timestamp with time zone NOT NULL,
    runtime_id uuid NOT NULL,
    profile text,
    session_profile text,
    session_ids text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    error jsonb,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    verify_session_ids text[] DEFAULT '{}'::text[] NOT NULL,
    verify_passes integer DEFAULT 0 NOT NULL,
    profile_removed_at timestamp with time zone,
    CONSTRAINT bot_host_cleanups_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT bot_host_cleanups_session_ids_check CHECK ((cardinality(session_ids) <= 2000)),
    CONSTRAINT bot_host_cleanups_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT bot_host_cleanups_verify_bounds CHECK (((cardinality(verify_session_ids) <= 2000) AND (verify_passes >= 0)))
);

ALTER TABLE ONLY public.bot_host_cleanups FORCE ROW LEVEL SECURITY;

-- comment: TABLE bot_host_cleanups
COMMENT ON TABLE public.bot_host_cleanups IS 'Durable cleanup of bot sessions and owned profiles on client runtimes.';

-- comment: COLUMN bot_host_cleanups.profile_removed_at
COMMENT ON COLUMN public.bot_host_cleanups.profile_removed_at IS 'When a pass proved the bot''s host profile absent (deleted, or never there). Set once; later verification passes skip the profile, and a new provision under the same name stops waiting.';

-- table: bot_permission_grants
CREATE TABLE public.bot_permission_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    tool_key text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_by_kind text NOT NULL,
    created_by_agency_organization_id uuid,
    created_from_approval_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by_user_id uuid,
    revoked_by_kind text,
    revoked_reason text,
    revoked_at timestamp with time zone,
    CONSTRAINT bot_permission_grants_agency_check CHECK (((created_by_kind = 'agency'::text) = (created_by_agency_organization_id IS NOT NULL))),
    CONSTRAINT bot_permission_grants_created_by_kind_check CHECK ((created_by_kind = 'member'::text)),
    CONSTRAINT bot_permission_grants_revocation_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL) AND (revoked_by_user_id IS NULL) AND (revoked_by_kind IS NULL) AND (revoked_reason IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL) AND (revoked_by_user_id IS NOT NULL) AND (revoked_by_kind IS NOT NULL)))),
    CONSTRAINT bot_permission_grants_revoked_by_kind_check CHECK (((revoked_by_kind IS NULL) OR (revoked_by_kind = 'member'::text))),
    CONSTRAINT bot_permission_grants_revoked_reason_check CHECK (((revoked_reason IS NULL) OR ((char_length(revoked_reason) >= 1) AND (char_length(revoked_reason) <= 200)))),
    CONSTRAINT bot_permission_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT bot_permission_grants_tool_key_check CHECK ((tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'::text))
);

ALTER TABLE ONLY public.bot_permission_grants FORCE ROW LEVEL SECURITY;

-- comment: TABLE bot_permission_grants
COMMENT ON TABLE public.bot_permission_grants IS 'PERM2-4: "Always for this tool on this bot". No expiry; active -> revoked only (trigger); one active row per (bot, tool_key). Read by the worker under its run''s organization.';

-- table: bot_permission_rules
CREATE TABLE public.bot_permission_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid,
    kind text NOT NULL,
    text text NOT NULL,
    source text DEFAULT 'settings'::text NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_by_kind text NOT NULL,
    created_by_agency_organization_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_permission_rules_agency_check CHECK (((created_by_kind = 'agency'::text) = (created_by_agency_organization_id IS NOT NULL))),
    CONSTRAINT bot_permission_rules_created_by_kind_check CHECK ((created_by_kind = 'member'::text)),
    CONSTRAINT bot_permission_rules_kind_check CHECK ((kind = ANY (ARRAY['allow'::text, 'ask_first'::text]))),
    CONSTRAINT bot_permission_rules_organization_actor_check CHECK (((bot_id IS NOT NULL) OR (created_by_kind = 'member'::text))),
    CONSTRAINT bot_permission_rules_source_check CHECK ((source = 'settings'::text)),
    CONSTRAINT bot_permission_rules_text_check CHECK ((((char_length(text) >= 1) AND (char_length(text) <= 1000)) AND (text = btrim(text)) AND (text !~ '[[:cntrl:]]'::text)))
);

ALTER TABLE ONLY public.bot_permission_rules FORCE ROW LEVEL SECURITY;

-- comment: TABLE bot_permission_rules
COMMENT ON TABLE public.bot_permission_rules IS 'PERM2-6: natural-language rules (allow, ask_first) read by the automatic reviewer only; bot_id null is the organization scope. At most 20 per (scope, kind). Written by the API (bot: owner, admin, mandated agency; organization: owner, admin); read by the worker per organization. Every write raises bots.permission_revision.';

-- table: bot_permission_tool_policies
CREATE TABLE public.bot_permission_tool_policies (
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    tool_key text NOT NULL,
    policy text NOT NULL,
    updated_by_user_id uuid,
    updated_by_kind text NOT NULL,
    updated_by_agency_organization_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_permission_tool_policies_actor_kind_check CHECK ((updated_by_kind = 'member'::text)),
    CONSTRAINT bot_permission_tool_policies_agency_actor_check CHECK (((updated_by_kind = 'agency'::text) = (updated_by_agency_organization_id IS NOT NULL))),
    CONSTRAINT bot_permission_tool_policies_policy_check CHECK ((policy = ANY (ARRAY['inherit'::text, 'always'::text, 'ask'::text, 'block'::text]))),
    CONSTRAINT bot_permission_tool_policies_tool_key_check CHECK ((tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'::text))
);

ALTER TABLE ONLY public.bot_permission_tool_policies FORCE ROW LEVEL SECURITY;

-- comment: TABLE bot_permission_tool_policies
COMMENT ON TABLE public.bot_permission_tool_policies IS 'PERM2-5: per-tool policy of a bot (inherit, always, ask, block). Written by the API (owner, admin, mandated agency); read by the worker per organization. Every write raises bots.permission_revision.';

-- comment: COLUMN bot_permission_tool_policies.updated_by_agency_organization_id
COMMENT ON COLUMN public.bot_permission_tool_policies.updated_by_agency_organization_id IS 'Agence qui a écrit la politique, quand updated_by_kind = agency. Trace historique sans FK (0171) : elle survit à la purge de l''agence.';

-- table: bot_playbooks
CREATE TABLE public.bot_playbooks (
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    playbook_id uuid NOT NULL
);

ALTER TABLE ONLY public.bot_playbooks FORCE ROW LEVEL SECURITY;

-- table: bot_profile_provisions
CREATE TABLE public.bot_profile_provisions (
    bot_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    provider text,
    model text,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    host_create_attempted boolean DEFAULT false NOT NULL,
    host_profile_ownership text DEFAULT 'unknown'::text NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    error jsonb,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    timings jsonb,
    progress jsonb,
    CONSTRAINT bot_profile_provisions_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT bot_profile_provisions_check CHECK (((provider IS NULL) = (model IS NULL))),
    CONSTRAINT bot_profile_provisions_host_profile_ownership_check CHECK ((host_profile_ownership = ANY (ARRAY['unknown'::text, 'ours'::text, 'foreign'::text]))),
    CONSTRAINT bot_profile_provisions_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.bot_profile_provisions FORCE ROW LEVEL SECURITY;

-- comment: TABLE bot_profile_provisions
COMMENT ON TABLE public.bot_profile_provisions IS 'Durable provisioning of managed Hermes profiles for roster bots.';

-- comment: COLUMN bot_profile_provisions.timings
COMMENT ON COLUMN public.bot_profile_provisions.timings IS 'Durations of the last provisioning pass in ms (claim wait, precheck, host create, approval policy, gateway serve wait, total) and its outcome. Names and durations only.';

-- comment: COLUMN bot_profile_provisions.progress
COMMENT ON COLUMN public.bot_profile_provisions.progress IS 'Step of the running provisioning pass, for the console: {"step": "space" | "rules" | "tools", "tools": [toolset names being enabled]}. Read only while queued or running.';

-- table: bot_routine_tools
CREATE TABLE public.bot_routine_tools (
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    switched_off boolean DEFAULT false NOT NULL,
    decided_by_user_id uuid,
    decided_at timestamp with time zone,
    runtime_id uuid,
    enabled_at timestamp with time zone,
    disabled_at timestamp with time zone,
    ready_at timestamp with time zone,
    restart_pending_since timestamp with time zone,
    blocked_reason text,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_routine_tools_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT bot_routine_tools_blocked_reason_check CHECK ((blocked_reason = ANY (ARRAY['https_required'::text, 'runtime_required'::text, 'host_offline'::text, 'host_unsupported'::text, 'profile_unsupported'::text, 'host_unreachable'::text, 'unverified'::text]))),
    CONSTRAINT bot_routine_tools_enabled_runtime CHECK ((((enabled_at IS NULL) AND (disabled_at IS NULL)) OR (runtime_id IS NOT NULL))),
    CONSTRAINT bot_routine_tools_one_proof CHECK (((enabled_at IS NULL) OR (disabled_at IS NULL)))
);

ALTER TABLE ONLY public.bot_routine_tools FORCE ROW LEVEL SECURITY;

-- table: bot_setting_proposals
CREATE TABLE public.bot_setting_proposals (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    run_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    reason text,
    current jsonb NOT NULL,
    proposed jsonb NOT NULL,
    hash text NOT NULL,
    base_updated_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_setting_proposals_current_check CHECK ((jsonb_typeof(current) = 'object'::text)),
    CONSTRAINT bot_setting_proposals_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bot_setting_proposals_proposed_check CHECK ((jsonb_typeof(proposed) = 'object'::text)),
    CONSTRAINT bot_setting_proposals_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 500))),
    CONSTRAINT bot_setting_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'superseded'::text, 'stale'::text])))
);

ALTER TABLE ONLY public.bot_setting_proposals FORCE ROW LEVEL SECURITY;

-- table: bots
CREATE TABLE public.bots (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    section_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    instructions text DEFAULT ''::text NOT NULL,
    model text,
    reasoning_effort text,
    hermes_profile text,
    "position" integer NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    face jsonb,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    autonomy_enabled boolean DEFAULT false NOT NULL,
    autonomy_max_depth integer DEFAULT 3 NOT NULL,
    autonomy_max_steps integer DEFAULT 8 NOT NULL,
    autonomy_max_handoffs integer DEFAULT 4 NOT NULL,
    autonomy_timeout_seconds integer DEFAULT 1800 NOT NULL,
    autonomy_token_budget bigint DEFAULT 120000 NOT NULL,
    voice_id text,
    deleted_at timestamp with time zone,
    hermes_profile_managed boolean DEFAULT false NOT NULL,
    label text,
    reply_language text DEFAULT 'auto'::text NOT NULL,
    notify_on_finish boolean DEFAULT true NOT NULL,
    speech_rate numeric(3,2) DEFAULT 1 NOT NULL,
    permission_mode text DEFAULT 'manual'::text NOT NULL,
    approval_policy_mode text,
    approval_policy_effective_at timestamp with time zone,
    capability_baseline_version integer DEFAULT 0 NOT NULL,
    creation_request_id uuid,
    creation_request_digest text,
    permission_revision bigint DEFAULT 0 NOT NULL,
    pin_position integer,
    host_profile_deleting_at timestamp with time zone,
    fast_mode boolean DEFAULT false NOT NULL,
    CONSTRAINT bots_approval_policy_mode_check CHECK (((approval_policy_mode IS NULL) OR (approval_policy_mode = ANY (ARRAY['ask_writes'::text, 'block_writes'::text, 'off'::text])))),
    CONSTRAINT bots_autonomy_max_depth_check CHECK (((autonomy_max_depth >= 1) AND (autonomy_max_depth <= 4))),
    CONSTRAINT bots_autonomy_max_handoffs_check CHECK (((autonomy_max_handoffs >= 0) AND (autonomy_max_handoffs <= 8))),
    CONSTRAINT bots_autonomy_max_steps_check CHECK (((autonomy_max_steps >= 1) AND (autonomy_max_steps <= 12))),
    CONSTRAINT bots_autonomy_timeout_check CHECK (((autonomy_timeout_seconds >= 60) AND (autonomy_timeout_seconds <= 3600))),
    CONSTRAINT bots_autonomy_token_budget_check CHECK (((autonomy_token_budget >= 1000) AND (autonomy_token_budget <= 200000))),
    CONSTRAINT bots_creation_request_digest_check CHECK (((creation_request_digest IS NULL) OR (creation_request_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT bots_creation_request_digest_needs_id CHECK (((creation_request_digest IS NULL) OR (creation_request_id IS NOT NULL))),
    CONSTRAINT bots_deleted_implies_archived CHECK (((deleted_at IS NULL) OR (archived_at IS NOT NULL))),
    CONSTRAINT bots_host_profile_deleting_implies_archived CHECK (((host_profile_deleting_at IS NULL) OR (archived_at IS NOT NULL))),
    CONSTRAINT bots_label_check CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 60)))),
    CONSTRAINT bots_permission_mode_check CHECK ((permission_mode = ANY (ARRAY['auto'::text, 'manual'::text, 'plan'::text, 'bypass'::text]))),
    CONSTRAINT bots_permission_revision_check CHECK ((permission_revision >= 0)),
    CONSTRAINT bots_reply_language_check CHECK ((reply_language = ANY (ARRAY['auto'::text, 'en'::text, 'fr'::text, 'es'::text, 'de'::text, 'it'::text, 'pt'::text, 'ja'::text, 'tr'::text]))),
    CONSTRAINT bots_speech_rate_check CHECK ((speech_rate = ANY (ARRAY[0.75, (1)::numeric, 1.25, 1.5]))),
    CONSTRAINT bots_voice_id_normalized_check CHECK (((voice_id IS NULL) OR (((char_length(voice_id) >= 1) AND (char_length(voice_id) <= 512)) AND (voice_id = btrim(voice_id)))))
);

ALTER TABLE ONLY public.bots FORCE ROW LEVEL SECURITY;

-- comment: COLUMN bots.deleted_at
COMMENT ON COLUMN public.bots.deleted_at IS 'Corbeille : l''utilisateur a supprimé ce bot, ses sessions runtime ne sont pas encore purgées. Toujours accompagné de archived_at (contrainte bots_deleted_implies_archived), ce qui le retire de toutes les requêtes qui filtrent archived_at is null.';

-- comment: COLUMN bots.hermes_profile_managed
COMMENT ON COLUMN public.bots.hermes_profile_managed IS 'openedbot a créé et possède le profil Hermes nommé correspondant ; false pour un profil explicite ou importé.';

-- comment: COLUMN bots.host_profile_deleting_at
COMMENT ON COLUMN public.bots.host_profile_deleting_at IS 'Suppression du profil hôte engagée : le bot reste archivé (contrainte bots_host_profile_deleting_implies_archived) jusqu''à sa suppression ; une reprise qui trouve le profil absent finalise le nettoyage local.';

-- table: email_login_codes
CREATE TABLE public.email_login_codes (
    id uuid NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_login_codes_attempts_check CHECK (((attempts >= 0) AND (attempts <= 5))),
    CONSTRAINT email_login_codes_email_check CHECK ((email = lower(email)))
);

ALTER TABLE ONLY public.email_login_codes FORCE ROW LEVEL SECURITY;

-- table: email_outbox
CREATE TABLE public.email_outbox (
    id uuid NOT NULL,
    kind text NOT NULL,
    dedupe_key text NOT NULL,
    recipient_email text,
    locale text DEFAULT 'fr'::text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    sent_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_delivery_failure_at timestamp with time zone,
    CONSTRAINT email_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT email_outbox_kind_check CHECK ((kind = ANY (ARRAY['organization_member_invitation'::text, 'staff_account_created'::text, 'staff_password_reset'::text, 'staff_login_code'::text, 'email_login_code'::text, 'provider_quota_reached'::text, 'account_purge_completed'::text, 'account_closure_notice'::text, 'support_new_conversation'::text, 'runtime_link_down'::text, 'runtime_link_restored'::text, 'runtime_connector_outdated'::text, 'workflow_approval'::text, 'workflow_completed'::text, 'workflow_failed'::text]))),
    CONSTRAINT email_outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT email_outbox_recipient_email_check CHECK (((recipient_email IS NULL) OR ((length(recipient_email) >= 3) AND (length(recipient_email) <= 320)))),
    CONSTRAINT email_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.email_outbox FORCE ROW LEVEL SECURITY;

-- table: email_outbox_events
CREATE TABLE public.email_outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    outbox_id uuid,
    kind text NOT NULL,
    event text NOT NULL,
    attempt integer,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_outbox_events_detail_check CHECK ((jsonb_typeof(detail) = 'object'::text)),
    CONSTRAINT email_outbox_events_erased_kinds_check CHECK (("left"(kind, 9) <> 'waitlist_'::text)),
    CONSTRAINT email_outbox_events_event_check CHECK ((event = ANY (ARRAY['queued'::text, 'duplicate_skipped'::text, 'sent'::text, 'retry'::text, 'failed'::text, 'lease_lost'::text])))
);

-- table: execution_commands
CREATE TABLE public.execution_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    thread_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    requested_by_user_id uuid,
    idempotency_key text,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    cancel_requested_at timestamp with time zone,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    progress jsonb,
    hermes_run jsonb,
    result jsonb,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_commands_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT execution_commands_check CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT execution_commands_check1 CHECK (((status <> 'running'::text) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT execution_commands_check2 CHECK (((status = 'succeeded'::text) = (result IS NOT NULL))),
    CONSTRAINT execution_commands_check3 CHECK (((status = ANY (ARRAY['failed'::text, 'cancelled'::text])) = (error_code IS NOT NULL))),
    CONSTRAINT execution_commands_error_code_check CHECK (((error_code IS NULL) OR (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text))),
    CONSTRAINT execution_commands_idempotency_key_check CHECK (((idempotency_key IS NULL) OR ((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200)))),
    CONSTRAINT execution_commands_kind_check CHECK ((kind = 'thread.compact'::text)),
    CONSTRAINT execution_commands_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.execution_commands FORCE ROW LEVEL SECURITY;

-- comment: TABLE execution_commands
COMMENT ON TABLE public.execution_commands IS 'Durable execution mutations recorded by the API and executed by the worker under a fenced lease (ADR 0001 S3).';

-- table: group_member_read_positions
CREATE TABLE public.group_member_read_positions (
    organization_id uuid NOT NULL,
    group_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    last_message_sequence bigint DEFAULT '-1'::integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_member_read_positions_last_message_sequence_check CHECK ((last_message_sequence >= '-1'::integer))
);

ALTER TABLE ONLY public.group_member_read_positions FORCE ROW LEVEL SECURITY;

-- table: group_members
CREATE TABLE public.group_members (
    organization_id uuid NOT NULL,
    group_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    "position" integer NOT NULL
);

ALTER TABLE ONLY public.group_members FORCE ROW LEVEL SECURITY;

-- table: marketplace_entries
CREATE TABLE public.marketplace_entries (
    id uuid NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text,
    document text,
    capabilities jsonb DEFAULT '{"mcp": [], "skills": [], "toolsets": []}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_url text,
    source_sha text,
    version text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_staff uuid,
    staff_override boolean DEFAULT false NOT NULL,
    CONSTRAINT marketplace_entries_capabilities_object CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT marketplace_entries_distribution_source CHECK (((kind <> 'agent_distribution'::text) OR ((source_url IS NOT NULL) AND (source_sha IS NOT NULL)))),
    CONSTRAINT marketplace_entries_document_size CHECK (((document IS NULL) OR (octet_length(document) <= 1000000))),
    CONSTRAINT marketplace_entries_kind_check CHECK ((kind = ANY (ARRAY['agent_template'::text, 'agent_distribution'::text]))),
    CONSTRAINT marketplace_entries_settings_object CHECK ((jsonb_typeof(settings) = 'object'::text)),
    CONSTRAINT marketplace_entries_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text)),
    CONSTRAINT marketplace_entries_source_sha_check CHECK (((source_sha IS NULL) OR (source_sha ~ '^[0-9a-f]{40}$'::text))),
    CONSTRAINT marketplace_entries_source_url_check CHECK (((source_url IS NULL) OR ((source_url ~ '^https://'::text) AND (char_length(source_url) <= 2048)))),
    CONSTRAINT marketplace_entries_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'withdrawn'::text]))),
    CONSTRAINT marketplace_entries_summary_length CHECK (((summary IS NULL) OR (char_length(summary) <= 500))),
    CONSTRAINT marketplace_entries_template_document CHECK (((kind <> 'agent_template'::text) OR (document IS NOT NULL))),
    CONSTRAINT marketplace_entries_title_length CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120))),
    CONSTRAINT marketplace_entries_version_length CHECK (((char_length(version) >= 1) AND (char_length(version) <= 40)))
);

-- comment: COLUMN marketplace_entries.staff_override
COMMENT ON COLUMN public.marketplace_entries.staff_override IS 'True after a staff write; fixture sync skips content updates for this row.';

-- table: membership_events
CREATE TABLE public.membership_events (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    subject_user_id uuid,
    kind text NOT NULL,
    role text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_organization_id uuid,
    CONSTRAINT membership_events_kind_check CHECK ((kind = ANY (ARRAY['invited'::text, 'accepted'::text, 'role_changed'::text, 'revoked'::text, 'member_invited'::text, 'member_joined'::text, 'member_invitation_canceled'::text])))
);

ALTER TABLE ONLY public.membership_events FORCE ROW LEVEL SECURITY;

-- table: memberships
CREATE TABLE public.memberships (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);

ALTER TABLE ONLY public.memberships FORCE ROW LEVEL SECURITY;

-- table: message_ingress
CREATE TABLE public.message_ingress (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    operation text NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    message_id uuid NOT NULL,
    run_id uuid NOT NULL,
    workflow_id uuid,
    attachment_manifest jsonb DEFAULT '[]'::jsonb NOT NULL,
    response_status integer,
    response_body jsonb,
    state text DEFAULT 'reserved'::text NOT NULL,
    reservation_owner text,
    reservation_lease_expires_at timestamp with time zone,
    reservation_epoch bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_ingress_attachment_manifest_check CHECK ((jsonb_typeof(attachment_manifest) = 'array'::text)),
    CONSTRAINT message_ingress_operation_check CHECK (((length(operation) >= 1) AND (length(operation) <= 64))),
    CONSTRAINT message_ingress_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT message_ingress_reservation_epoch_check CHECK ((reservation_epoch >= 0)),
    CONSTRAINT message_ingress_response_body_check CHECK (((response_body IS NULL) OR (jsonb_typeof(response_body) = 'object'::text))),
    CONSTRAINT message_ingress_response_status_check CHECK (((response_status IS NULL) OR ((response_status >= 100) AND (response_status <= 599)))),
    CONSTRAINT message_ingress_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'completed'::text, 'abandoned'::text])))
);

ALTER TABLE ONLY public.message_ingress FORCE ROW LEVEL SECURITY;

-- table: message_reactions
CREATE TABLE public.message_reactions (
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_reactions_emoji_check CHECK (((char_length(emoji) >= 1) AND (char_length(emoji) <= 16)))
);

ALTER TABLE ONLY public.message_reactions FORCE ROW LEVEL SECURITY;

-- table: message_versions
CREATE TABLE public.message_versions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    root_thread_id uuid NOT NULL,
    root_message_id uuid NOT NULL,
    parent_thread_id uuid NOT NULL,
    parent_message_id uuid NOT NULL,
    branch_thread_id uuid NOT NULL,
    branch_message_id uuid NOT NULL,
    run_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    created_by_user_id uuid,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    kind text NOT NULL,
    ordinal smallint NOT NULL,
    source_sequence bigint NOT NULL,
    copied_message_count smallint NOT NULL,
    prefix_truncated boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_versions_check CHECK ((root_thread_id <> branch_thread_id)),
    CONSTRAINT message_versions_check1 CHECK ((parent_thread_id <> branch_thread_id)),
    CONSTRAINT message_versions_check2 CHECK ((root_message_id <> branch_message_id)),
    CONSTRAINT message_versions_check3 CHECK ((parent_message_id <> branch_message_id)),
    CONSTRAINT message_versions_copied_message_count_check CHECK (((copied_message_count >= 0) AND (copied_message_count <= 200))),
    CONSTRAINT message_versions_kind_check CHECK ((kind = ANY (ARRAY['edit'::text, 'regenerate'::text]))),
    CONSTRAINT message_versions_ordinal_check CHECK (((ordinal >= 1) AND (ordinal <= 19))),
    CONSTRAINT message_versions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT message_versions_source_sequence_check CHECK ((source_sequence >= 0))
);

ALTER TABLE ONLY public.message_versions FORCE ROW LEVEL SECURITY;

-- table: messages
CREATE TABLE public.messages (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid,
    role text NOT NULL,
    content jsonb NOT NULL,
    author_bot_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sequence bigint NOT NULL,
    original_author_bot_id uuid,
    original_author_name text,
    reply_to_id uuid,
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT messages_sequence_nonnegative CHECK ((sequence >= 0))
);

ALTER TABLE ONLY public.messages FORCE ROW LEVEL SECURITY;

-- table: mobile_connect_tickets
CREATE TABLE public.mobile_connect_tickets (
    id uuid NOT NULL,
    secret_hash text NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.mobile_connect_tickets FORCE ROW LEVEL SECURITY;

-- table: native_auth_codes
CREATE TABLE public.native_auth_codes (
    id uuid NOT NULL,
    organization_id uuid,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    code_challenge text NOT NULL,
    redirect_uri text NOT NULL,
    client_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.native_auth_codes FORCE ROW LEVEL SECURITY;

-- table: oauth_attempts
CREATE TABLE public.oauth_attempts (
    attempt_hash text NOT NULL,
    state_hash text NOT NULL,
    payload_ciphertext text NOT NULL,
    payload_nonce text NOT NULL,
    payload_tag text NOT NULL,
    payload_key_id text NOT NULL,
    return_to text,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_code text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_attempts_check CHECK (((failure_code IS NULL) OR (status = 'failed'::text))),
    CONSTRAINT oauth_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'exchanging'::text, 'done_web'::text, 'done_native'::text, 'done_link'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.oauth_attempts FORCE ROW LEVEL SECURITY;

-- table: operator_profiles
CREATE TABLE public.operator_profiles (
    organization_id uuid NOT NULL,
    username text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.operator_profiles FORCE ROW LEVEL SECURITY;

-- table: organization_agent_templates
CREATE TABLE public.organization_agent_templates (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text,
    document text NOT NULL,
    capabilities jsonb DEFAULT '{"mcp": [], "skills": [], "toolsets": []}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    version text DEFAULT '1.0.0'::text NOT NULL,
    source_bot_id uuid,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_agent_templates_capabilities_object CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT organization_agent_templates_document_size CHECK ((octet_length(document) <= 1000000)),
    CONSTRAINT organization_agent_templates_settings_object CHECK ((jsonb_typeof(settings) = 'object'::text)),
    CONSTRAINT organization_agent_templates_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text)),
    CONSTRAINT organization_agent_templates_summary_length CHECK (((summary IS NULL) OR (char_length(summary) <= 500))),
    CONSTRAINT organization_agent_templates_title_length CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120))),
    CONSTRAINT organization_agent_templates_version_length CHECK (((char_length(version) >= 1) AND (char_length(version) <= 40)))
);

ALTER TABLE ONLY public.organization_agent_templates FORCE ROW LEVEL SECURITY;

-- table: organization_member_invitations
CREATE TABLE public.organization_member_invitations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    invited_by_user_id uuid,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    accepted_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_member_invitations_email_check CHECK ((email = lower(btrim(email)))),
    CONSTRAINT organization_member_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT organization_member_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'canceled'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.organization_member_invitations FORCE ROW LEVEL SECURITY;

-- table: organization_permission_policies
CREATE TABLE public.organization_permission_policies (
    organization_id uuid NOT NULL,
    max_mode text,
    enforce_review boolean DEFAULT false NOT NULL,
    rules_mode text DEFAULT 'adds'::text NOT NULL,
    command_blocklist text[] DEFAULT '{}'::text[] NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_user_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_permission_policies_blocklist_check CHECK (public.permission_command_blocklist_valid(command_blocklist)),
    CONSTRAINT organization_permission_policies_max_mode_check CHECK (((max_mode IS NULL) OR (max_mode = ANY (ARRAY['manual'::text, 'auto'::text, 'bypass'::text])))),
    CONSTRAINT organization_permission_policies_rules_mode_check CHECK ((rules_mode = ANY (ARRAY['adds'::text, 'replaces'::text]))),
    CONSTRAINT organization_permission_policies_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY public.organization_permission_policies FORCE ROW LEVEL SECURITY;

-- comment: TABLE organization_permission_policies
COMMENT ON TABLE public.organization_permission_policies IS 'PERM2-8: ceiling, enforced review, rules mode and command blocklist of an organization. Written only by set_organization_permission_policy (owner or admin); read by the API tenant and the worker pipeline.';

-- table: organizations
CREATE TABLE public.organizations (
    id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    onboarding jsonb,
    onboarded_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    runtime_mode text,
    model_assignment_mode text DEFAULT 'per_bot'::text NOT NULL,
    kind text DEFAULT 'personal'::text NOT NULL,
    personal_owner_user_id uuid,
    permission_pipeline text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT organizations_kind_check CHECK ((kind = 'personal'::text)),
    CONSTRAINT organizations_model_assignment_mode_check CHECK ((model_assignment_mode = ANY (ARRAY['global'::text, 'per_bot'::text]))),
    CONSTRAINT organizations_permission_pipeline_check CHECK ((permission_pipeline = ANY (ARRAY['legacy'::text, 'v2'::text]))),
    CONSTRAINT organizations_personal_owner_kind CHECK (((kind = 'personal'::text) OR (personal_owner_user_id IS NULL))),
    CONSTRAINT organizations_runtime_mode_check CHECK (((runtime_mode IS NULL) OR (runtime_mode = ANY (ARRAY['bundled'::text, 'external'::text])))),
    CONSTRAINT organizations_slug_url_segment CHECK (((slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text) AND (slug !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);

ALTER TABLE ONLY public.organizations FORCE ROW LEVEL SECURITY;

-- comment: COLUMN organizations.runtime_mode
COMMENT ON COLUMN public.organizations.runtime_mode IS 'Retired; retained for compatibility, no longer read by API or worker.';

-- table: playbooks
CREATE TABLE public.playbooks (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    triggers text[] DEFAULT '{}'::text[] NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbooks_instructions_length CHECK ((length(instructions) <= 24000)),
    CONSTRAINT playbooks_key_length CHECK (((length(key) >= 1) AND (length(key) <= 80))),
    CONSTRAINT playbooks_name_length CHECK (((length(name) >= 1) AND (length(name) <= 200))),
    CONSTRAINT playbooks_summary_length CHECK ((length(summary) <= 2000))
);

ALTER TABLE ONLY public.playbooks FORCE ROW LEVEL SECURITY;

-- table: product_features
CREATE TABLE public.product_features (
    feature_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    audience text DEFAULT 'off'::text NOT NULL,
    dev boolean DEFAULT false NOT NULL,
    prod boolean DEFAULT false NOT NULL,
    CONSTRAINT product_features_audience_check CHECK ((audience = ANY (ARRAY['off'::text, 'staff'::text, 'all'::text]))),
    CONSTRAINT product_features_feature_key_check CHECK ((feature_key ~ '^[a-z][a-z0-9_]{0,63}$'::text))
);

-- table: profile_delete_jobs
CREATE TABLE public.profile_delete_jobs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_by_user_id uuid,
    runtime_id uuid NOT NULL,
    slugs text[] NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    total_profiles integer NOT NULL,
    completed_profiles integer DEFAULT 0 NOT NULL,
    current_slug text,
    results jsonb DEFAULT '[]'::jsonb NOT NULL,
    error jsonb,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT profile_delete_jobs_check CHECK ((total_profiles = cardinality(slugs))),
    CONSTRAINT profile_delete_jobs_check1 CHECK ((completed_profiles <= total_profiles)),
    CONSTRAINT profile_delete_jobs_completed_profiles_check CHECK (((completed_profiles >= 0) AND (completed_profiles <= 64))),
    CONSTRAINT profile_delete_jobs_slugs_check CHECK (((cardinality(slugs) >= 1) AND (cardinality(slugs) <= 64))),
    CONSTRAINT profile_delete_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT profile_delete_jobs_total_profiles_check CHECK (((total_profiles >= 1) AND (total_profiles <= 64)))
);

ALTER TABLE ONLY public.profile_delete_jobs FORCE ROW LEVEL SECURITY;

-- comment: TABLE profile_delete_jobs
COMMENT ON TABLE public.profile_delete_jobs IS 'Durable bounded Hermes host profile deletions; worker-owned, polled by the console.';

-- table: profile_import_items
CREATE TABLE public.profile_import_items (
    job_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    ordinal integer NOT NULL,
    slug text NOT NULL,
    entry jsonb,
    bot_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    avatar_id uuid NOT NULL,
    avatar_stored boolean DEFAULT false NOT NULL,
    creation_state text DEFAULT 'not_started'::text NOT NULL,
    operation jsonb,
    selection jsonb,
    bot_model text,
    limitations jsonb DEFAULT '[]'::jsonb NOT NULL,
    capabilities_done boolean DEFAULT false NOT NULL,
    completed_operations jsonb DEFAULT '[]'::jsonb NOT NULL,
    reservation_released_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT profile_import_items_creation_state_check CHECK ((creation_state = ANY (ARRAY['not_started'::text, 'sending'::text, 'created'::text, 'not_created'::text, 'deleting'::text, 'deleted'::text, 'unknown'::text]))),
    CONSTRAINT profile_import_items_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 31))),
    CONSTRAINT profile_import_items_slug_check CHECK (((slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'::text) AND (slug <> 'default'::text)))
);

ALTER TABLE ONLY public.profile_import_items FORCE ROW LEVEL SECURITY;

-- comment: COLUMN profile_import_items.operation
COMMENT ON COLUMN public.profile_import_items.operation IS 'Committed before external mutation; an unresolved intent is never replayed after lease loss.';

-- comment: COLUMN profile_import_items.reservation_released_at
COMMENT ON COLUMN public.profile_import_items.reservation_released_at IS 'Unknown host outcomes remain reserved until explicit human acknowledgement.';

-- table: profile_import_jobs
CREATE TABLE public.profile_import_jobs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_by_user_id uuid,
    runtime_id uuid NOT NULL,
    section_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    digest text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    phase text DEFAULT 'prevalidation'::text NOT NULL,
    total_profiles integer NOT NULL,
    completed_profiles integer DEFAULT 0 NOT NULL,
    result jsonb,
    error jsonb,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    review_after timestamp with time zone,
    acknowledged_by uuid,
    CONSTRAINT profile_import_jobs_completed_profiles_check CHECK (((completed_profiles >= 0) AND (completed_profiles <= 32))),
    CONSTRAINT profile_import_jobs_digest_check CHECK ((length(digest) = 64)),
    CONSTRAINT profile_import_jobs_phase_check CHECK ((phase = ANY (ARRAY['prevalidation'::text, 'creation'::text, 'roster'::text, 'capabilities'::text, 'compensation'::text, 'finished'::text]))),
    CONSTRAINT profile_import_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'needs_attention'::text]))),
    CONSTRAINT profile_import_jobs_total_profiles_check CHECK (((total_profiles >= 1) AND (total_profiles <= 32)))
);

ALTER TABLE ONLY public.profile_import_jobs FORCE ROW LEVEL SECURITY;

-- comment: TABLE profile_import_jobs
COMMENT ON TABLE public.profile_import_jobs IS 'Durable bounded Hermes archive imports; no raw YAML, credentials or skill content.';

-- table: push_deliveries
CREATE TABLE public.push_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    notification_sequence bigint NOT NULL,
    subscription_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT push_deliveries_notification_sequence_check CHECK ((notification_sequence > 0)),
    CONSTRAINT push_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'gone'::text])))
);

ALTER TABLE ONLY public.push_deliveries FORCE ROW LEVEL SECURITY;

-- comment: TABLE push_deliveries
COMMENT ON TABLE public.push_deliveries IS 'Idempotence du fan-out Web Push : une livraison par (workflow, sequence, abonnement). Un retry du worker retrouve la ligne et ne renvoie pas.';

-- table: push_outbox
CREATE TABLE public.push_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    notification_sequence bigint NOT NULL,
    event_type text NOT NULL,
    bot_id uuid,
    bot_name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT push_outbox_bot_name_check CHECK (((length(bot_name) >= 1) AND (length(bot_name) <= 200))),
    CONSTRAINT push_outbox_event_type_check CHECK ((event_type = ANY (ARRAY['approval.requested'::text, 'run.completed'::text, 'run.error'::text]))),
    CONSTRAINT push_outbox_last_error_check CHECK (((last_error IS NULL) OR (length(last_error) <= 500))),
    CONSTRAINT push_outbox_notification_sequence_check CHECK ((notification_sequence > 0)),
    CONSTRAINT push_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])))
);

ALTER TABLE ONLY public.push_outbox FORCE ROW LEVEL SECURITY;

-- comment: TABLE push_outbox
COMMENT ON TABLE public.push_outbox IS 'Transitions de workflow eligibles au Web Push. Une ligne par (workflow, notification_sequence) ; le worker fan-out vers push_deliveries. Aucun texte de fil.';

-- table: push_subscriptions
CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    locale text DEFAULT 'fr'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    failed_at timestamp with time zone,
    CONSTRAINT push_subscriptions_auth_check CHECK (((length(auth) >= 8) AND (length(auth) <= 128))),
    CONSTRAINT push_subscriptions_endpoint_check CHECK (((length(endpoint) >= 8) AND (length(endpoint) <= 2048))),
    CONSTRAINT push_subscriptions_endpoint_check1 CHECK ((endpoint ~~ 'https://%'::text)),
    CONSTRAINT push_subscriptions_locale_check CHECK ((locale = ANY (ARRAY['fr'::text, 'en'::text]))),
    CONSTRAINT push_subscriptions_p256dh_check CHECK (((length(p256dh) >= 16) AND (length(p256dh) <= 256))),
    CONSTRAINT push_subscriptions_user_agent_check CHECK (((user_agent IS NULL) OR ((length(user_agent) >= 1) AND (length(user_agent) <= 512))))
);

ALTER TABLE ONLY public.push_subscriptions FORCE ROW LEVEL SECURITY;

-- comment: TABLE push_subscriptions
COMMENT ON TABLE public.push_subscriptions IS 'Abonnements Web Push VAPID par utilisateur. L''endpoint est unique au monde : un meme navigateur ne peut pas rester rattache a deux comptes. Cascade a la purge du tenant et au depart d''un membre.';

-- table: routine_executions
CREATE TABLE public.routine_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    routine_id uuid NOT NULL,
    outcome text NOT NULL,
    trigger text NOT NULL,
    missed_count integer DEFAULT 0 NOT NULL,
    busy_retries integer,
    error_code text,
    error_message text,
    workflow_id uuid,
    run_id uuid,
    thread_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT routine_executions_busy_retries_check CHECK (((busy_retries IS NULL) OR (busy_retries >= 0))),
    CONSTRAINT routine_executions_error_code_check CHECK (((error_code IS NULL) OR ((length(error_code) >= 1) AND (length(error_code) <= 80)))),
    CONSTRAINT routine_executions_error_message_check CHECK (((error_message IS NULL) OR ((length(error_message) >= 1) AND (length(error_message) <= 500)))),
    CONSTRAINT routine_executions_missed_count_check CHECK ((missed_count >= 0)),
    CONSTRAINT routine_executions_outcome_check CHECK ((outcome = ANY (ARRAY['fired'::text, 'catch_up'::text, 'deferred'::text, 'abandoned'::text, 'group_empty'::text]))),
    CONSTRAINT routine_executions_trigger_check CHECK ((trigger = ANY (ARRAY['scheduled'::text, 'manual'::text])))
);

ALTER TABLE ONLY public.routine_executions FORCE ROW LEVEL SECURITY;

-- comment: TABLE routine_executions
COMMENT ON TABLE public.routine_executions IS 'Historique d''un tick de routine : tir, rattrapage, report de fil occupe, abandon au plafond, salon vide. RLS tenant ; le worker ecrit, l''API lit.';

-- table: routines
CREATE TABLE public.routines (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid,
    name text NOT NULL,
    schedule text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    message text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    missed_count integer DEFAULT 0 NOT NULL,
    last_missed_at timestamp with time zone,
    busy_retries integer DEFAULT 0 NOT NULL,
    group_id uuid,
    never_wait boolean DEFAULT false NOT NULL,
    CONSTRAINT routines_bot_xor_group CHECK (((bot_id IS NOT NULL) <> (group_id IS NOT NULL))),
    CONSTRAINT routines_busy_retries_nonneg CHECK ((busy_retries >= 0)),
    CONSTRAINT routines_missed_count_nonneg CHECK ((missed_count >= 0))
);

ALTER TABLE ONLY public.routines FORCE ROW LEVEL SECURITY;

-- comment: COLUMN routines.missed_count
COMMENT ON COLUMN public.routines.missed_count IS 'Occurrences planifiées sautées (catch-up borné + reports de fil occupé épuisés). Compteur cumulatif, plafond de comptage côté worker.';

-- comment: COLUMN routines.last_missed_at
COMMENT ON COLUMN public.routines.last_missed_at IS 'Dernier instant où missed_count a été incrémenté.';

-- comment: COLUMN routines.busy_retries
COMMENT ON COLUMN public.routines.busy_retries IS 'Reports consécutifs +60 s tant que le fil DM du bot est occupé. Remis à zéro après un tir ou un saut d''occurrence.';

-- comment: COLUMN routines.group_id
COMMENT ON COLUMN public.routines.group_id IS 'Salon cible, exclusif de bot_id. Un tir ouvre un envoi de salon (workflow kind group).';

-- table: run_events
CREATE TABLE public.run_events (
    cursor bigint NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    sequence integer NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    bot_id uuid,
    turn_id uuid,
    session_key text,
    lease_generation bigint,
    CONSTRAINT run_events_lease_generation_nonnegative CHECK (((lease_generation IS NULL) OR (lease_generation >= 0)))
);

ALTER TABLE ONLY public.run_events FORCE ROW LEVEL SECURITY;

-- sequence: run_events_cursor_seq
ALTER TABLE public.run_events ALTER COLUMN cursor ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.run_events_cursor_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- table: run_steering_attempts
CREATE TABLE public.run_steering_attempts (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    target_run_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    forwarding_owner text,
    forwarding_epoch bigint DEFAULT 0 NOT NULL,
    forwarding_lease_expires_at timestamp with time zone,
    response_status integer,
    error_code text,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_steering_attempts_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT run_steering_attempts_check CHECK ((target_run_id <> source_run_id)),
    CONSTRAINT run_steering_attempts_check1 CHECK ((((status = 'sending'::text) AND (forwarding_owner IS NOT NULL) AND (forwarding_lease_expires_at IS NOT NULL)) OR ((status <> 'sending'::text) AND (forwarding_owner IS NULL) AND (forwarding_lease_expires_at IS NULL)))),
    CONSTRAINT run_steering_attempts_check2 CHECK (((status = 'confirmed'::text) = (delivered_at IS NOT NULL))),
    CONSTRAINT run_steering_attempts_forwarding_epoch_check CHECK ((forwarding_epoch >= 0)),
    CONSTRAINT run_steering_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'confirmed'::text, 'unsupported'::text, 'rejected'::text, 'ambiguous'::text, 'expired'::text]))),
    CONSTRAINT run_steering_attempts_text_check CHECK (((char_length(text) >= 1) AND (char_length(text) <= 65536)))
);

ALTER TABLE ONLY public.run_steering_attempts FORCE ROW LEVEL SECURITY;

-- table: runs
CREATE TABLE public.runs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    bot_id uuid,
    group_turn_position integer,
    input text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    model text,
    hermes_run_id text,
    output text,
    usage jsonb,
    error_code text,
    error_message text,
    last_hermes_sequence integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_state jsonb,
    handoff_target_bot_id uuid,
    origin_run_id uuid,
    next_attempt_at timestamp with time zone,
    lease_generation bigint DEFAULT 0 NOT NULL,
    external_state text DEFAULT 'not_started'::text NOT NULL,
    events_complete boolean DEFAULT true NOT NULL,
    remote_stop_state text,
    workflow_id uuid,
    step_index integer,
    step_kind text,
    stack_depth integer DEFAULT 0 NOT NULL,
    caller_bot_id uuid,
    caller_run_id uuid,
    resumes_run_id uuid,
    completion_kind text,
    execution_session_key text,
    initiator_user_id uuid,
    deadline_at timestamp with time zone,
    origin text,
    timings jsonb,
    plan_only boolean DEFAULT false NOT NULL,
    source_message_id uuid,
    user_time_zone text,
    CONSTRAINT runs_completion_kind_length_check CHECK (((completion_kind IS NULL) OR ((length(completion_kind) >= 1) AND (length(completion_kind) <= 64)))),
    CONSTRAINT runs_execution_session_key_length_check CHECK (((execution_session_key IS NULL) OR ((length(execution_session_key) >= 1) AND (length(execution_session_key) <= 200)))),
    CONSTRAINT runs_external_state_check CHECK ((external_state = ANY (ARRAY['not_started'::text, 'creating'::text, 'streaming'::text, 'polling'::text, 'stopping'::text, 'settled'::text, 'ambiguous'::text]))),
    CONSTRAINT runs_lease_generation_nonnegative CHECK ((lease_generation >= 0)),
    CONSTRAINT runs_origin_check CHECK (((origin IS NULL) OR (origin = 'bot_greeting'::text))),
    CONSTRAINT runs_remote_stop_state_check CHECK (((remote_stop_state IS NULL) OR (remote_stop_state = ANY (ARRAY['requested'::text, 'confirmed'::text, 'ambiguous'::text, 'failed'::text])))),
    CONSTRAINT runs_stack_depth_check CHECK (((stack_depth >= 0) AND (stack_depth <= 4))),
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'awaiting_approval'::text, 'relaying'::text, 'unknown'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT runs_step_index_nonnegative CHECK (((step_index IS NULL) OR (step_index >= 0))),
    CONSTRAINT runs_step_kind_check CHECK (((step_kind IS NULL) OR (step_kind = ANY (ARRAY['root'::text, 'delegated'::text, 'continuation'::text, 'group'::text, 'memory'::text, 'persona_draft'::text, 'compaction'::text])))),
    CONSTRAINT runs_user_time_zone_check CHECK ((user_time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'::text))
);

ALTER TABLE ONLY public.runs FORCE ROW LEVEL SECURITY;

-- comment: COLUMN runs.timings
COMMENT ON COLUMN public.runs.timings IS 'Latency of the worker pass (`runLatencyRecord`): queuedMs, marks and spans in ms from the claim, verdicts. Names and durations only.';

-- comment: COLUMN runs.plan_only
COMMENT ON COLUMN public.runs.plan_only IS 'The operator asked this turn for a plan only: decided as `plan` whatever the bot''s permission mode. Set at insert, never changed.';

-- comment: COLUMN runs.source_message_id
COMMENT ON COLUMN public.runs.source_message_id IS 'Retry only: the operator message (bound to the original run) whose attachments this run replays. Set at insert, never changed.';

-- table: runtime_a2a_audit
CREATE TABLE public.runtime_a2a_audit (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    source text DEFAULT 'a2a_audit'::text NOT NULL,
    source_offset bigint NOT NULL,
    source_kind text NOT NULL,
    ts double precision NOT NULL,
    direction text NOT NULL,
    peer text NOT NULL,
    task_id text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_a2a_audit_direction_check CHECK ((((source_kind = 'upstream'::text) AND (direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'push'::text]))) OR ((source_kind = ANY (ARRAY['operator.policy_probe'::text, 'operator.policy_guard'::text])) AND (direction = 'denied'::text)))),
    CONSTRAINT runtime_a2a_audit_offset_check CHECK ((source_offset >= 0)),
    CONSTRAINT runtime_a2a_audit_peer_check CHECK ((peer ~ '^[A-Za-z0-9][A-Za-z0-9._:@_-]{0,127}$'::text)),
    CONSTRAINT runtime_a2a_audit_source_check CHECK ((((source = 'a2a_audit'::text) AND (source_kind = ANY (ARRAY['upstream'::text, 'operator.policy_probe'::text]))) OR ((source = 'policy_denials'::text) AND (source_kind = 'operator.policy_guard'::text)))),
    CONSTRAINT runtime_a2a_audit_source_kind_check CHECK ((source_kind = ANY (ARRAY['upstream'::text, 'operator.policy_probe'::text, 'operator.policy_guard'::text]))),
    CONSTRAINT runtime_a2a_audit_task_check CHECK ((((task_id IS NOT NULL) AND (task_id ~ '^task-[a-f0-9]{16}$'::text)) OR ((source_kind = 'operator.policy_guard'::text) AND (task_id IS NULL)))),
    CONSTRAINT runtime_a2a_audit_timestamp_check CHECK (((ts > (0)::double precision) AND (ts < ('253402300800'::bigint)::double precision)))
);

ALTER TABLE ONLY public.runtime_a2a_audit FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_a2a_audit
COMMENT ON TABLE public.runtime_a2a_audit IS 'Sanitized metadata from two fixed A2A append files. The key includes file and byte offset; task-less policy denials do not invent upstream tasks. No summary, request arguments, token, or raw JSON is stored.';

-- table: runtime_audit_anchors
CREATE TABLE public.runtime_audit_anchors (
    runtime_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    key_id text NOT NULL,
    write_seq bigint NOT NULL,
    event_count integer NOT NULL,
    dropped bigint NOT NULL,
    tail text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_audit_anchors_dropped_check CHECK ((dropped >= 0)),
    CONSTRAINT runtime_audit_anchors_event_count_check CHECK ((event_count >= 0)),
    CONSTRAINT runtime_audit_anchors_key_id_check CHECK ((key_id ~ '^[A-Za-z0-9._~-]{1,128}$'::text)),
    CONSTRAINT runtime_audit_anchors_tail_check CHECK ((tail ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_audit_anchors_write_seq_check CHECK ((write_seq >= 0))
);

ALTER TABLE ONLY public.runtime_audit_anchors FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_audit_anchors
COMMENT ON TABLE public.runtime_audit_anchors IS 'Dernière ancre audit.anchor reçue par runtime : writeSeq, compteurs et tail de la chaîne. Un export en retrait de l''ancre est une copie antérieure, pas l''audit courant — ce que ni le chiffrement ni la chaîne seuls ne détectent.';

-- table: runtime_audit_keys
CREATE TABLE public.runtime_audit_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    key_id text NOT NULL,
    ciphertext text NOT NULL,
    nonce text NOT NULL,
    tag text NOT NULL,
    key_encryption_key_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT runtime_audit_keys_key_id_check CHECK ((key_id ~ '^[A-Za-z0-9._~-]{1,128}$'::text))
);

ALTER TABLE ONLY public.runtime_audit_keys FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_audit_keys
COMMENT ON TABLE public.runtime_audit_keys IS 'Clé maîtresse de l''audit de création par runtime, chiffrée par le keyring des bearers. Remise au connecteur à chaque session (audit.key), jamais écrite sur le VPS. Une clé retirée n''est jamais purgée tant que le runtime existe : les exports scellés sous elle restent vérifiables.';

-- table: runtime_bot_settings_tools
CREATE TABLE public.runtime_bot_settings_tools (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    secret_hash text NOT NULL,
    server_name text DEFAULT 'openedbot_bot_settings'::text NOT NULL,
    installed_at timestamp with time zone,
    enabled_bot_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_bot_settings_tools_secret_hash_check CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_bot_settings_tools_server_name_check CHECK ((server_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text))
);

ALTER TABLE ONLY public.runtime_bot_settings_tools FORCE ROW LEVEL SECURITY;

-- table: runtime_connector_notices
CREATE TABLE public.runtime_connector_notices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    installed_version text NOT NULL,
    target_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    push_status text DEFAULT 'pending'::text NOT NULL,
    push_processed_at timestamp with time zone,
    CONSTRAINT runtime_connector_notices_installed_version_check CHECK (((length(installed_version) >= 1) AND (length(installed_version) <= 64))),
    CONSTRAINT runtime_connector_notices_push_status_check CHECK ((push_status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'skipped'::text]))),
    CONSTRAINT runtime_connector_notices_target_version_check CHECK (((length(target_version) >= 1) AND (length(target_version) <= 64)))
);

ALTER TABLE ONLY public.runtime_connector_notices FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_connector_notices
COMMENT ON TABLE public.runtime_connector_notices IS 'Outdated connector notices: one per (runtime, announced version, target version). Dedupe record for the owner e-mail and web push; no token, no address.';

-- table: runtime_connector_release_seen
CREATE TABLE public.runtime_connector_release_seen (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version text NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_connector_release_seen_version_check CHECK ((version ~ '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text))
);

ALTER TABLE ONLY public.runtime_connector_release_seen FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_connector_release_seen
COMMENT ON TABLE public.runtime_connector_release_seen IS 'Edge-setup release announcements a member closed: one row per (organization, member, version). Version only, no text.';

-- table: runtime_direct_exposures
CREATE TABLE public.runtime_direct_exposures (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid,
    created_by_user_id uuid,
    kind text NOT NULL,
    hostname text NOT NULL,
    endpoint text NOT NULL,
    cloudflare_account_id text,
    zone_id text,
    tunnel_id text,
    dns_record_id text,
    access_app_id text,
    service_token_id text,
    install_token_ciphertext text,
    install_token_nonce text,
    install_token_tag text,
    install_token_key_id text,
    edge_auth_ciphertext text,
    edge_auth_nonce text,
    edge_auth_tag text,
    edge_auth_key_id text,
    status text DEFAULT 'awaiting_install'::text NOT NULL,
    last_tunnel_status text,
    last_checked_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    tailscale_auth_key_id text,
    cleanup_status text,
    CONSTRAINT runtime_direct_exposures_cleanup_status_check CHECK ((cleanup_status = ANY (ARRAY['pending'::text, 'done'::text, 'manual'::text]))),
    CONSTRAINT runtime_direct_exposures_cloudflare_shape CHECK (((kind = 'tailscale_funnel'::text) OR ((cloudflare_account_id IS NOT NULL) AND (zone_id IS NOT NULL) AND (tunnel_id IS NOT NULL)))),
    CONSTRAINT runtime_direct_exposures_edge_auth_envelope CHECK ((((edge_auth_ciphertext IS NULL) AND (edge_auth_nonce IS NULL) AND (edge_auth_tag IS NULL) AND (edge_auth_key_id IS NULL)) OR ((edge_auth_ciphertext IS NOT NULL) AND (edge_auth_nonce IS NOT NULL) AND (edge_auth_tag IS NOT NULL) AND (edge_auth_key_id IS NOT NULL)))),
    CONSTRAINT runtime_direct_exposures_hostname_check CHECK ((hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'::text)),
    CONSTRAINT runtime_direct_exposures_install_token_envelope CHECK ((((install_token_ciphertext IS NULL) AND (install_token_nonce IS NULL) AND (install_token_tag IS NULL) AND (install_token_key_id IS NULL)) OR ((install_token_ciphertext IS NOT NULL) AND (install_token_nonce IS NOT NULL) AND (install_token_tag IS NOT NULL) AND (install_token_key_id IS NOT NULL)))),
    CONSTRAINT runtime_direct_exposures_kind_check CHECK ((kind = ANY (ARRAY['customer_cloudflare'::text, 'managed_cloudflare'::text, 'tailscale_funnel'::text]))),
    CONSTRAINT runtime_direct_exposures_status_check CHECK ((status = ANY (ARRAY['awaiting_install'::text, 'reachable'::text, 'declared'::text, 'failed'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.runtime_direct_exposures FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_direct_exposures
COMMENT ON TABLE public.runtime_direct_exposures IS 'Publication of a direct gateway (openedbot-managed Cloudflare, Tailscale Funnel). customer_cloudflare is legacy: readable and revocable, never created again.';

-- comment: COLUMN runtime_direct_exposures.install_token_ciphertext
COMMENT ON COLUMN public.runtime_direct_exposures.install_token_ciphertext IS 'cloudflared connector token, encrypted; erased once the runtime is declared.';

-- comment: COLUMN runtime_direct_exposures.tailscale_auth_key_id
COMMENT ON COLUMN public.runtime_direct_exposures.tailscale_auth_key_id IS 'Identifiant de la clé d''appairage Tailscale créée pour cette publication ; la clé elle-même vit dans install_token_ciphertext.';

-- table: runtime_enrollments
CREATE TABLE public.runtime_enrollments (
    id uuid NOT NULL,
    secret_hash text NOT NULL,
    endpoint text,
    runtime_name text NOT NULL,
    verification_code text NOT NULL,
    organization_id uuid,
    claimed_by uuid,
    claimed_at timestamp with time zone,
    consumed_at timestamp with time zone,
    runtime_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reachability text DEFAULT 'direct'::text NOT NULL,
    CONSTRAINT runtime_enrollments_claim_pair_check CHECK (((claimed_at IS NULL) = (organization_id IS NULL))),
    CONSTRAINT runtime_enrollments_consumed_after_claim_check CHECK (((consumed_at IS NULL) OR (claimed_at IS NOT NULL))),
    CONSTRAINT runtime_enrollments_reachability_check CHECK ((reachability = ANY (ARRAY['direct'::text, 'connector'::text]))),
    CONSTRAINT runtime_enrollments_reachability_endpoint_check CHECK (((reachability = 'direct'::text) = (endpoint IS NOT NULL)))
);

ALTER TABLE ONLY public.runtime_enrollments FORCE ROW LEVEL SECURITY;

-- comment: COLUMN runtime_enrollments.reachability
COMMENT ON COLUMN public.runtime_enrollments.reachability IS 'direct : l''enrôlement porte l''URL à sonder ; connector : endpoint NULL, la preuve passe par le lien.';

-- table: runtime_link_alerts
CREATE TABLE public.runtime_link_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    runtime_name text NOT NULL,
    kind text DEFAULT 'link_down'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reason text,
    down_since timestamp with time zone NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    concerned_user_id uuid,
    notified_at timestamp with time zone,
    notified_recipients integer DEFAULT 0 NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    CONSTRAINT runtime_link_alerts_kind_check CHECK ((kind = 'link_down'::text)),
    CONSTRAINT runtime_link_alerts_resolution_check CHECK (((status = 'resolved'::text) = (resolved_at IS NOT NULL))),
    CONSTRAINT runtime_link_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.runtime_link_alerts FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_link_alerts
COMMENT ON TABLE public.runtime_link_alerts IS 'Pannes durables du lien connecteur par runtime : ouverture, résolution, utilisateur concerné, e-mail déposé et acquittement staff.';

-- table: runtime_link_diagnostics
CREATE TABLE public.runtime_link_diagnostics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    event_id uuid NOT NULL,
    component text NOT NULL,
    state text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    stack text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    receiver_instance_id text,
    receiver_generation bigint,
    CONSTRAINT runtime_link_diagnostics_code_check CHECK ((code ~ '^[A-Z][A-Z0-9_]{0,63}$'::text)),
    CONSTRAINT runtime_link_diagnostics_component_check CHECK ((component = ANY (ARRAY['link'::text, 'operator'::text]))),
    CONSTRAINT runtime_link_diagnostics_message_check CHECK ((octet_length(message) <= 256)),
    CONSTRAINT runtime_link_diagnostics_receiver_generation_check CHECK ((receiver_generation > 0)),
    CONSTRAINT runtime_link_diagnostics_stack_check CHECK ((octet_length(stack) <= 8192)),
    CONSTRAINT runtime_link_diagnostics_state_check CHECK ((state = ANY (ARRAY['unavailable'::text, 'recovered'::text])))
);

ALTER TABLE ONLY public.runtime_link_diagnostics FORCE ROW LEVEL SECURITY;

-- comment: COLUMN runtime_link_diagnostics.receiver_instance_id
COMMENT ON COLUMN public.runtime_link_diagnostics.receiver_instance_id IS 'Receiving broker api_instances.instance_id; not the origin of a spooled event.';

-- comment: COLUMN runtime_link_diagnostics.receiver_generation
COMMENT ON COLUMN public.runtime_link_diagnostics.receiver_generation IS 'Receiving WebSocket lease generation; not the generation at original failure time.';

-- table: runtime_link_dispatches
CREATE TABLE public.runtime_link_dispatches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    instance_id text NOT NULL,
    generation bigint,
    idempotency_key_hash text,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    status integer,
    remote_id text,
    CONSTRAINT runtime_link_dispatches_generation_check CHECK ((generation > 0)),
    CONSTRAINT runtime_link_dispatches_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_link_dispatches_remote_id_check CHECK ((remote_id ~ '^[A-Za-z0-9._~-]{1,128}$'::text)),
    CONSTRAINT runtime_link_dispatches_status_check CHECK (((status >= 100) AND (status <= 599)))
);

ALTER TABLE ONLY public.runtime_link_dispatches FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_link_dispatches
COMMENT ON TABLE public.runtime_link_dispatches IS 'Un enregistrement par POST /v1/runs relayé par le broker vers un runtime connector : le SHA-256 de l''Idempotency-Key, l''instant, le statut et le run_id distant lu sur la réponse bornée. Jumeau côté API de l''audit du connecteur : un événement d''audit sans dispatch ici est une invention.';

-- sequence: runtime_link_generation_seq
CREATE SEQUENCE public.runtime_link_generation_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- table: runtime_model_proven
CREATE TABLE public.runtime_model_proven (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    proven_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.runtime_model_proven FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_model_proven
COMMENT ON TABLE public.runtime_model_proven IS 'Runtime model selections that completed a successful inference proof.';

-- table: runtime_model_selection_proofs
CREATE TABLE public.runtime_model_selection_proofs (
    runtime_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider text,
    model text,
    reasoning_effort text,
    status text DEFAULT 'queued'::text NOT NULL,
    request_generation bigint DEFAULT 1 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    error jsonb,
    lease_owner text,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    lease_token uuid,
    CONSTRAINT runtime_model_selection_proofs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT runtime_model_selection_proofs_check CHECK (((provider IS NULL) = (model IS NULL))),
    CONSTRAINT runtime_model_selection_proofs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.runtime_model_selection_proofs FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_model_selection_proofs
COMMENT ON TABLE public.runtime_model_selection_proofs IS 'Pending runtime model selections awaiting a worker canary proof.';

-- table: runtime_permission_settings
CREATE TABLE public.runtime_permission_settings (
    runtime_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    terminal_danger_always boolean DEFAULT false NOT NULL,
    updated_by_user_id uuid NOT NULL,
    updated_by_kind text NOT NULL,
    updated_by_agency_organization_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_permission_settings_agency_check CHECK (((updated_by_kind = 'agency'::text) = (updated_by_agency_organization_id IS NOT NULL))),
    CONSTRAINT runtime_permission_settings_updated_by_kind_check CHECK ((updated_by_kind = 'member'::text))
);

ALTER TABLE ONLY public.runtime_permission_settings FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_permission_settings
COMMENT ON TABLE public.runtime_permission_settings IS 'PERM2-4 (D-3): per runtime, the switch that answers dangerous-command gates once for every bot of the runtime. Read by the worker under its run''s organization.';

-- table: runtime_provider_incidents
CREATE TABLE public.runtime_provider_incidents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    until timestamp with time zone NOT NULL,
    fallback_provider text,
    fallback_model text,
    run_id uuid,
    message text,
    CONSTRAINT runtime_provider_incidents_kind_check CHECK ((kind = ANY (ARRAY['quota'::text, 'auth'::text]))),
    CONSTRAINT runtime_provider_incidents_message_bounded CHECK (((message IS NULL) OR (length(message) <= 500))),
    CONSTRAINT runtime_provider_incidents_provider_len CHECK (((length(provider) >= 1) AND (length(provider) <= 120)))
);

ALTER TABLE ONLY public.runtime_provider_incidents FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_provider_incidents
COMMENT ON TABLE public.runtime_provider_incidents IS 'Panne quota/auth d un fournisseur d inference, par runtime. Un incident non expire exclut ce fournisseur de resolveRunnableSelection. Repli par run, jamais une reecriture de runtimes.selected_* ni bots.model.';

-- table: runtime_read_snapshots
CREATE TABLE public.runtime_read_snapshots (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    kind text NOT NULL,
    document jsonb,
    observed_at timestamp with time zone NOT NULL,
    invalidated_at timestamp with time zone,
    CONSTRAINT runtime_read_snapshots_document_check CHECK (((document IS NULL) OR (jsonb_typeof(document) = 'object'::text))),
    CONSTRAINT runtime_read_snapshots_kind_check CHECK ((kind = ANY (ARRAY['mcp'::text, 'models'::text, 'profiles'::text, 'integrations'::text]))),
    CONSTRAINT runtime_read_snapshots_tombstone_check CHECK (((document IS NOT NULL) OR (invalidated_at IS NOT NULL)))
);

ALTER TABLE ONLY public.runtime_read_snapshots FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_read_snapshots
COMMENT ON TABLE public.runtime_read_snapshots IS 'Public DTO snapshots only, never a raw host body or a secret. A null document is an invalidation tombstone.';

-- table: runtime_review_profiles
CREATE TABLE public.runtime_review_profiles (
    runtime_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    proven_at timestamp with time zone,
    checked_at timestamp with time zone,
    failure_code text,
    attempts integer DEFAULT 0 NOT NULL,
    next_check_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_inventory_at timestamp with time zone,
    verified_link_generation bigint,
    CONSTRAINT runtime_review_profiles_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT runtime_review_profiles_check CHECK (((status = 'proven'::text) = (proven_at IS NOT NULL))),
    CONSTRAINT runtime_review_profiles_check1 CHECK (((lease_token IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT runtime_review_profiles_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[A-Z0-9_]{1,64}$'::text))),
    CONSTRAINT runtime_review_profiles_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'proven'::text, 'pending_restart'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.runtime_review_profiles FORCE ROW LEVEL SECURITY;

-- comment: TABLE runtime_review_profiles
COMMENT ON TABLE public.runtime_review_profiles IS 'PERM2-7a: proof per runtime that the openedbot-reviewer profile runs without any tool. Written by the worker only.';

-- comment: COLUMN runtime_review_profiles.verified_inventory_at
COMMENT ON COLUMN public.runtime_review_profiles.verified_inventory_at IS 'runtimes.inventory_changed_at seen when the last successful check was claimed; a later host signal makes a proven row due again.';

-- comment: COLUMN runtime_review_profiles.verified_link_generation
COMMENT ON COLUMN public.runtime_review_profiles.verified_link_generation IS 'runtimes.link_generation seen when the last successful check was claimed; a reconnection makes a proven row due again.';

-- table: runtime_routine_tools
CREATE TABLE public.runtime_routine_tools (
    organization_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    secret_hash text NOT NULL,
    server_name text DEFAULT 'openedbot_routines'::text NOT NULL,
    installed_at timestamp with time zone,
    enabled_bot_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    auth_failed_at timestamp with time zone,
    root_failures integer DEFAULT 0 NOT NULL,
    root_failed_link_at timestamp with time zone,
    CONSTRAINT runtime_routine_tools_root_failures_check CHECK ((root_failures >= 0)),
    CONSTRAINT runtime_routine_tools_secret_hash_check CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_routine_tools_server_name_check CHECK ((server_name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text))
);

ALTER TABLE ONLY public.runtime_routine_tools FORCE ROW LEVEL SECURITY;

-- table: runtimes
CREATE TABLE public.runtimes (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    endpoint text,
    token_ciphertext text,
    token_nonce text,
    token_tag text,
    capacity integer DEFAULT 4 NOT NULL,
    revoked_at timestamp with time zone,
    last_health_status text DEFAULT 'unknown'::text NOT NULL,
    last_health_error text,
    last_probed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    selected_provider text,
    selected_model text,
    reasoning_effort text,
    token_key_id text,
    is_active boolean DEFAULT false NOT NULL,
    reachability text DEFAULT 'direct'::text NOT NULL,
    link_token_hash text,
    link_instance_id text,
    link_connected_at timestamp with time zone,
    link_last_seen_at timestamp with time zone,
    link_features text[] DEFAULT '{}'::text[] NOT NULL,
    link_token_previous_hash text,
    link_token_rotated_at timestamp with time zone,
    link_token_previous_expires_at timestamp with time zone,
    link_generation bigint DEFAULT 0 NOT NULL,
    link_device_pubkey text,
    link_token_expires_at timestamp with time zone,
    link_agent text,
    link_agent_seen_at timestamp with time zone,
    edge_auth_ciphertext text,
    edge_auth_nonce text,
    edge_auth_tag text,
    edge_auth_key_id text,
    toolset_epoch bigint DEFAULT 0 NOT NULL,
    link_origin text,
    inventory_changed_at timestamp with time zone,
    link_hermes_version text,
    capabilities_changed_at timestamp with time zone,
    profile_capabilities_changed_at jsonb DEFAULT '{}'::jsonb NOT NULL,
    link_token_rotation_unconfirmed_at timestamp with time zone,
    link_sessions_reconciled_at timestamp with time zone,
    CONSTRAINT runtimes_active_not_revoked CHECK (((NOT is_active) OR (revoked_at IS NULL))),
    CONSTRAINT runtimes_capacity_check CHECK (((capacity >= 1) AND (capacity <= 100))),
    CONSTRAINT runtimes_edge_auth_envelope CHECK ((((edge_auth_ciphertext IS NULL) AND (edge_auth_nonce IS NULL) AND (edge_auth_tag IS NULL) AND (edge_auth_key_id IS NULL)) OR ((reachability = 'direct'::text) AND (edge_auth_ciphertext IS NOT NULL) AND (edge_auth_nonce IS NOT NULL) AND (edge_auth_tag IS NOT NULL) AND (edge_auth_key_id IS NOT NULL)))),
    CONSTRAINT runtimes_link_device_pubkey_check CHECK ((link_device_pubkey ~ '^[A-Za-z0-9+/]{43}=$'::text)),
    CONSTRAINT runtimes_link_generation_check CHECK ((link_generation >= 0)),
    CONSTRAINT runtimes_link_hermes_version_length CHECK ((char_length(link_hermes_version) <= 64)),
    CONSTRAINT runtimes_link_origin_check CHECK (((link_origin IS NULL) OR (((char_length(link_origin) >= 1) AND (char_length(link_origin) <= 200)) AND (link_origin ~ '^https?://[A-Za-z0-9._:-]+$'::text)))),
    CONSTRAINT runtimes_profile_capabilities_changed_at_check CHECK ((jsonb_typeof(profile_capabilities_changed_at) = 'object'::text)),
    CONSTRAINT runtimes_reachability_check CHECK ((reachability = ANY (ARRAY['direct'::text, 'connector'::text]))),
    CONSTRAINT runtimes_reachability_shape_check CHECK ((((reachability = 'direct'::text) AND (endpoint IS NOT NULL) AND (token_ciphertext IS NOT NULL) AND (token_nonce IS NOT NULL) AND (token_tag IS NOT NULL) AND (link_token_hash IS NULL)) OR ((reachability = 'connector'::text) AND (endpoint IS NULL) AND (token_ciphertext IS NULL) AND (token_nonce IS NULL) AND (token_tag IS NULL) AND (link_token_hash IS NOT NULL)))),
    CONSTRAINT runtimes_reasoning_effort_check CHECK (((reasoning_effort IS NULL) OR (reasoning_effort = ANY (ARRAY['none'::text, 'minimal'::text, 'low'::text, 'medium'::text, 'high'::text, 'xhigh'::text]))))
);

ALTER TABLE ONLY public.runtimes FORCE ROW LEVEL SECURITY;

-- comment: COLUMN runtimes.reachability
COMMENT ON COLUMN public.runtimes.reachability IS 'direct : URL publique + bearer chiffré ; connector : lien sortant ouvert par l''hôte, endpoint et token NULL par contrainte.';

-- comment: COLUMN runtimes.link_token_hash
COMMENT ON COLUMN public.runtimes.link_token_hash IS 'SHA-256 du jeton de lien du connecteur, jamais le jeton ; porte RLS runtimes_link_credential.';

-- comment: COLUMN runtimes.link_instance_id
COMMENT ON COLUMN public.runtimes.link_instance_id IS 'Instance d''API qui tient le WebSocket du lien ; NULL hors connexion.';

-- comment: COLUMN runtimes.link_connected_at
COMMENT ON COLUMN public.runtimes.link_connected_at IS 'Ouverture de la connexion de lien courante ; NULL quand le lien est fermé.';

-- comment: COLUMN runtimes.link_last_seen_at
COMMENT ON COLUMN public.runtimes.link_last_seen_at IS 'Dernier signe de vie du lien connecteur.';

-- comment: COLUMN runtimes.link_features
COMMENT ON COLUMN public.runtimes.link_features IS 'Capacités annoncées dans hello.features par le connecteur (ex. provider_management) ; réécrites à chaque connexion, vides pour un runtime direct.';

-- comment: COLUMN runtimes.link_token_previous_hash
COMMENT ON COLUMN public.runtimes.link_token_previous_hash IS 'SHA-256 du jeton de lien PRÉCÉDENT, accepté jusqu''à link_token_previous_expires_at ; NULL hors rotation.';

-- comment: COLUMN runtimes.link_token_rotated_at
COMMENT ON COLUMN public.runtimes.link_token_rotated_at IS 'Dernière rotation du jeton de lien ; NULL si jamais tourné.';

-- comment: COLUMN runtimes.link_token_previous_expires_at
COMMENT ON COLUMN public.runtimes.link_token_previous_expires_at IS 'Fin de la fenêtre de grâce de l''ancien jeton ; le worker efface le hash précédent au-delà.';

-- comment: COLUMN runtimes.link_generation
COMMENT ON COLUMN public.runtimes.link_generation IS 'Database-ordered WebSocket lease. Every liveness write must fence by this generation and instance.';

-- comment: COLUMN runtimes.link_device_pubkey
COMMENT ON COLUMN public.runtimes.link_device_pubkey IS 'Clé publique Ed25519 (base64, 32 octets) de la machine enrôlée. Présente, une session du lien n''est liée qu''après link.challenge / link.proof ; un jeton volé seul n''ouvre rien.';

-- comment: COLUMN runtimes.link_token_expires_at
COMMENT ON COLUMN public.runtimes.link_token_expires_at IS 'Échéance informative du jeton de lien courant, posée par la rotation automatique du worker (LINK_TOKEN_MAX_AGE_HOURS). Jamais lue pour refuser une montée : la rotation elle-même remplace le hash.';

-- comment: COLUMN runtimes.link_agent
COMMENT ON COLUMN public.runtimes.link_agent IS 'Agent déclaré dans hello par le dernier lien admis, tronqué à 256 caractères. Informatif : une version obsolète ne refuse jamais la session.';

-- comment: COLUMN runtimes.link_agent_seen_at
COMMENT ON COLUMN public.runtimes.link_agent_seen_at IS 'Date de réception de la dernière déclaration d''agent admise, conservée après déconnexion. NULL avant la première déclaration.';

-- comment: COLUMN runtimes.toolset_epoch
COMMENT ON COLUMN public.runtimes.toolset_epoch IS 'Bumped after openedbot relays a host write that can change the toolset inventory. Part of the worker inventory cache key; carries no data.';

-- comment: COLUMN runtimes.link_origin
COMMENT ON COLUMN public.runtimes.link_origin IS 'HTTPS origin (http loopback in development) the connector signed at its last proof of possession. Not dialed by openedbot.';

-- comment: COLUMN runtimes.inventory_changed_at
COMMENT ON COLUMN public.runtimes.inventory_changed_at IS 'Last inventory.changed signal from the host connector (files behind toolsets, MCP and skills moved). Carries no data.';

-- comment: COLUMN runtimes.link_hermes_version
COMMENT ON COLUMN public.runtimes.link_hermes_version IS 'Hermes version declared in hello by the last admitted link (hello.hermesVersion), raw, at most 64 characters. Informative: it never refuses a session. NULL before the first declaration or when hello carried none.';

-- comment: COLUMN runtimes.capabilities_changed_at
COMMENT ON COLUMN public.runtimes.capabilities_changed_at IS 'Last relayed capability write at the host root (toolsets, MCP servers, root credentials, gateway restart).';

-- comment: COLUMN runtimes.profile_capabilities_changed_at
COMMENT ON COLUMN public.runtimes.profile_capabilities_changed_at IS 'Last relayed capability write per Hermes profile: {"<slug>": "<timestamptz>"}.';

-- comment: COLUMN runtimes.link_token_rotation_unconfirmed_at
COMMENT ON COLUMN public.runtimes.link_token_rotation_unconfirmed_at IS 'Automatic link token rotation whose link.rotate delivery is unknown: both hashes stay valid until the host is admitted again (new token confirms, previous token reverts). NULL otherwise.';

-- comment: COLUMN runtimes.link_sessions_reconciled_at
COMMENT ON COLUMN public.runtimes.link_sessions_reconciled_at IS 'Last session reconciliation attempt for this connector runtime (worker link-security pass). NULL before the first one; the pass reads the oldest first.';

-- table: sections
CREATE TABLE public.sections (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer NOT NULL,
    collapsed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context text DEFAULT ''::text NOT NULL,
    CONSTRAINT sections_context_length CHECK ((length(context) <= 24000))
);

ALTER TABLE ONLY public.sections FORCE ROW LEVEL SECURITY;

-- table: service_instances
CREATE TABLE public.service_instances (
    id text NOT NULL,
    service text NOT NULL,
    process_id integer NOT NULL,
    rss_bytes bigint NOT NULL,
    heap_used_bytes bigint NOT NULL,
    active_work integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    permission_pipelines text[],
    CONSTRAINT service_instances_active_work_check CHECK ((active_work >= 0)),
    CONSTRAINT service_instances_heap_used_bytes_check CHECK ((heap_used_bytes >= 0)),
    CONSTRAINT service_instances_permission_pipelines_check CHECK (((permission_pipelines IS NULL) OR (permission_pipelines <@ ARRAY['legacy'::text, 'v2'::text]))),
    CONSTRAINT service_instances_rss_bytes_check CHECK ((rss_bytes >= 0)),
    CONSTRAINT service_instances_service_check CHECK ((service = ANY (ARRAY['api'::text, 'worker'::text])))
);

-- table: sessions
CREATE TABLE public.sessions (
    id uuid NOT NULL,
    organization_id uuid,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    session_token_hash text,
    access_token_hash text,
    refresh_token_hash text,
    csrf_hash text,
    access_expires_at timestamp with time zone NOT NULL,
    refresh_expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    ip inet,
    family_id uuid,
    revoked_reason text,
    impersonated_by_staff_user_id uuid,
    refresh_attempt_hash text,
    refresh_recovery_until timestamp with time zone,
    CONSTRAINT sessions_impersonation_web_check CHECK (((impersonated_by_staff_user_id IS NULL) OR (kind = 'web'::text))),
    CONSTRAINT sessions_kind_check CHECK ((kind = ANY (ARRAY['web'::text, 'native'::text]))),
    CONSTRAINT sessions_refresh_recovery_pair CHECK ((((refresh_attempt_hash IS NULL) AND (refresh_recovery_until IS NULL)) OR ((kind = 'native'::text) AND (refresh_attempt_hash IS NOT NULL) AND (refresh_recovery_until IS NOT NULL) AND (family_id IS NOT NULL)))),
    CONSTRAINT sessions_revoked_reason_check CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['logout'::text, 'user_revoked'::text, 'password_change'::text, 'refresh_rotation'::text, 'google_unlink'::text]))))
);

ALTER TABLE ONLY public.sessions FORCE ROW LEVEL SECURITY;

-- table: staff_login_codes
CREATE TABLE public.staff_login_codes (
    id uuid NOT NULL,
    staff_user_id uuid NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_login_codes_attempts_check CHECK (((attempts >= 0) AND (attempts <= 5)))
);

ALTER TABLE ONLY public.staff_login_codes FORCE ROW LEVEL SECURITY;

-- comment: TABLE staff_login_codes
COMMENT ON TABLE public.staff_login_codes IS 'One-time staff sign-in codes. The clear code is only in the e-mail outbox until send; this table keeps the hash.';

-- table: staff_sessions
CREATE TABLE public.staff_sessions (
    id uuid NOT NULL,
    staff_user_id uuid NOT NULL,
    session_token_hash text NOT NULL,
    csrf_hash text,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent text,
    ip inet,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.staff_sessions FORCE ROW LEVEL SECURITY;

-- table: staff_users
CREATE TABLE public.staff_users (
    id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    display_name text,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.staff_users FORCE ROW LEVEL SECURITY;

-- table: stripe_events
CREATE TABLE public.stripe_events (
    id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    error text
);

-- table: subscriptions
CREATE TABLE public.subscriptions (
    organization_id uuid NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    status text DEFAULT 'inactive'::text NOT NULL,
    current_period_end timestamp with time zone,
    runtime_limit integer DEFAULT 0 NOT NULL,
    member_limit integer DEFAULT 1 NOT NULL,
    concurrent_run_limit integer DEFAULT 0 NOT NULL,
    attachment_quota_bytes bigint DEFAULT 0 NOT NULL,
    stripe_event_created bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.subscriptions FORCE ROW LEVEL SECURITY;

-- table: support_attachments
CREATE TABLE public.support_attachments (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    object_key text NOT NULL,
    driver text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_attachments_bytes_check CHECK (((bytes >= 1) AND (bytes <= 1048576))),
    CONSTRAINT support_attachments_check CHECK ((object_key ~~ (('support/'::text || (conversation_id)::text) || '/%'::text))),
    CONSTRAINT support_attachments_content_type_check CHECK ((content_type ~~ 'image/%'::text)),
    CONSTRAINT support_attachments_driver_check CHECK ((driver = ANY (ARRAY['file'::text, 'r2'::text]))),
    CONSTRAINT support_attachments_name_check CHECK (((length(name) >= 1) AND (length(name) <= 300)))
);

ALTER TABLE ONLY public.support_attachments FORCE ROW LEVEL SECURITY;

-- comment: TABLE support_attachments
COMMENT ON TABLE public.support_attachments IS 'Les captures jointes à un message de support. Hors tenant, sous la RLS du fil parent. Les octets vivent dans le magasin de blobs, jamais ici.';

-- table: support_conversations
CREATE TABLE public.support_conversations (
    id uuid NOT NULL,
    guest_token_hash text NOT NULL,
    email text NOT NULL,
    locale text DEFAULT 'fr'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_staff_user_id uuid,
    user_id uuid,
    last_guest_message_at timestamp with time zone,
    last_staff_message_at timestamp with time zone,
    staff_read_at timestamp with time zone,
    guest_read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_conversations_email_check CHECK (((length(email) >= 3) AND (length(email) <= 320))),
    CONSTRAINT support_conversations_guest_token_hash_check CHECK ((length(guest_token_hash) = 64)),
    CONSTRAINT support_conversations_locale_check CHECK ((locale = ANY (ARRAY['fr'::text, 'en'::text]))),
    CONSTRAINT support_conversations_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.support_conversations FORCE ROW LEVEL SECURITY;

-- comment: TABLE support_conversations
COMMENT ON TABLE public.support_conversations IS 'Un fil de support par jeton invité. Hors tenant : aucune organisation n''existe quand un visiteur écrit. La porte invité est le condensat du jeton, la porte staff une session staff vivante.';

-- table: support_events
CREATE TABLE public.support_events (
    cursor bigint NOT NULL,
    conversation_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT support_events_type_check CHECK (((length(type) >= 1) AND (length(type) <= 100)))
);

ALTER TABLE ONLY public.support_events FORCE ROW LEVEL SECURITY;

-- comment: TABLE support_events
COMMENT ON TABLE public.support_events IS 'Le flux SSE du guichet. `cursor` est le Last-Event-ID des deux portées : un fil pour l''invité, tous les fils pour le staff.';

-- sequence: support_events_cursor_seq
ALTER TABLE public.support_events ALTER COLUMN cursor ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.support_events_cursor_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- table: support_messages
CREATE TABLE public.support_messages (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    author text NOT NULL,
    staff_user_id uuid,
    body text NOT NULL,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_messages_author_check CHECK ((author = ANY (ARRAY['guest'::text, 'staff'::text]))),
    CONSTRAINT support_messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 4000))),
    CONSTRAINT support_messages_check CHECK (((author = 'staff'::text) = (staff_user_id IS NOT NULL))),
    CONSTRAINT support_messages_idempotency_key_check CHECK (((idempotency_key IS NULL) OR ((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200))))
);

ALTER TABLE ONLY public.support_messages FORCE ROW LEVEL SECURITY;

-- comment: TABLE support_messages
COMMENT ON TABLE public.support_messages IS 'Les messages d''un fil de support. `author` nomme le côté ; un seul index unique partiel porte l''idempotence d''un POST rejoué.';

-- table: team_imports
CREATE TABLE public.team_imports (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    source_id text NOT NULL,
    source_release text NOT NULL,
    document_sha256 text NOT NULL,
    team_name text NOT NULL,
    section_id uuid NOT NULL,
    result jsonb NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_imports_document_sha256_check CHECK ((document_sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.team_imports FORCE ROW LEVEL SECURITY;

-- table: tenant_blob_deletions
CREATE TABLE public.tenant_blob_deletions (
    object_key text NOT NULL,
    organization_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    driver text,
    CONSTRAINT tenant_blob_deletions_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT tenant_blob_deletions_driver_check CHECK ((driver = ANY (ARRAY['file'::text, 'r2'::text]))),
    CONSTRAINT tenant_blob_deletions_key_shape CHECK (((object_key ~ '^org/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) OR (object_key ~ '^support/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text))),
    CONSTRAINT tenant_blob_deletions_object_key_check CHECK (((length(object_key) >= 1) AND (length(object_key) <= 1024))),
    CONSTRAINT tenant_blob_deletions_owner CHECK ((((object_key ~~ 'org/%'::text) AND (organization_id IS NOT NULL) AND (object_key ~~ (('org/'::text || (organization_id)::text) || '/%'::text))) OR ((object_key ~~ 'support/%'::text) AND (organization_id IS NULL))))
);

ALTER TABLE ONLY public.tenant_blob_deletions FORCE ROW LEVEL SECURITY;

-- comment: TABLE tenant_blob_deletions
COMMENT ON TABLE public.tenant_blob_deletions IS 'La file durable des octets à supprimer, pour tout le produit : clés de tenant (org/…) et clés du guichet de support (support/…). Drainée par le worker avec bail et réessai.';

-- table: tenant_deletions
CREATE TABLE public.tenant_deletions (
    organization_id uuid NOT NULL,
    reason text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error text,
    purge_after timestamp with time zone,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone
);

ALTER TABLE ONLY public.tenant_deletions FORCE ROW LEVEL SECURITY;

-- table: thread_compactions
CREATE TABLE public.thread_compactions (
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    summary text NOT NULL,
    compacted_through_sequence integer NOT NULL,
    source_message_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_compactions_count_nonneg CHECK ((source_message_count >= 0)),
    CONSTRAINT thread_compactions_sequence_nonneg CHECK ((compacted_through_sequence >= 0)),
    CONSTRAINT thread_compactions_summary_length CHECK (((char_length(summary) >= 1) AND (char_length(summary) <= 16000)))
);

ALTER TABLE ONLY public.thread_compactions FORCE ROW LEVEL SECURITY;

-- table: thread_hides
CREATE TABLE public.thread_hides (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    hidden_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.thread_hides FORCE ROW LEVEL SECURITY;

-- table: thread_message_counters
CREATE TABLE public.thread_message_counters (
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    next_sequence bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_message_counters_next_sequence_check CHECK ((next_sequence >= 0))
);

ALTER TABLE ONLY public.thread_message_counters FORCE ROW LEVEL SECURITY;

-- table: thread_reads
CREATE TABLE public.thread_reads (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    read_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.thread_reads FORCE ROW LEVEL SECURITY;

-- table: threads
CREATE TABLE public.threads (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid,
    group_id uuid,
    title text NOT NULL,
    hermes_session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    hermes_session_generation integer DEFAULT 0 NOT NULL,
    hermes_session_opened_at timestamp with time zone,
    CONSTRAINT threads_default_task_check CHECK (((NOT is_default) OR (bot_id IS NOT NULL))),
    CONSTRAINT threads_hermes_session_generation_check CHECK ((hermes_session_generation >= 0)),
    CONSTRAINT threads_owner_at_most_one CHECK (((((bot_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) <= 1))
);

ALTER TABLE ONLY public.threads FORCE ROW LEVEL SECURITY;

-- comment: COLUMN threads.hermes_session_generation
COMMENT ON COLUMN public.threads.hermes_session_generation IS 'Hermes session generation of the thread: 0 uses hermes_session_id, n > 0 uses hermes_session_id || '':gen'' || n.';

-- comment: COLUMN threads.hermes_session_opened_at
COMMENT ON COLUMN public.threads.hermes_session_opened_at IS 'When the current generation''s Hermes session served its first run (null: not yet, or before 0163).';

-- table: tool_errors
CREATE TABLE public.tool_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    user_id uuid,
    tool text NOT NULL,
    tool_call_id text NOT NULL,
    error_message text,
    duration_ms integer,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text DEFAULT 'TOOL_EXECUTION_FAILED'::text NOT NULL,
    CONSTRAINT tool_errors_duration_nonnegative CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT tool_errors_error_code_check CHECK ((error_code = ANY (ARRAY['PYTHON_DEPENDENCY_MISSING'::text, 'APPROVAL_REQUIRED'::text, 'TOOL_EXECUTION_FAILED'::text]))),
    CONSTRAINT tool_errors_message_bounded CHECK (((error_message IS NULL) OR (length(error_message) <= 500)))
);

ALTER TABLE ONLY public.tool_errors FORCE ROW LEVEL SECURITY;

-- comment: TABLE tool_errors
COMMENT ON TABLE public.tool_errors IS 'Échecs d''outils par tenant : une ligne par `tool.result` en erreur, écrite par le worker dans la transaction de l''événement. `error_message` est borné (500) et rédigé (secrets masqués) ; NULL quand le runtime n''a transmis aucun texte. Purgée par le worker au-delà de `WORKER_TOOL_ERRORS_RETENTION_DAYS`. La suppression d''un bot, d''un fil ou d''un run emporte ses lignes.';

-- table: user_workspace_preferences
CREATE TABLE public.user_workspace_preferences (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    approval_enabled_at timestamp with time zone,
    completed_enabled_at timestamp with time zone,
    failed_enabled_at timestamp with time zone,
    locale text DEFAULT 'fr'::text NOT NULL,
    checklist_hidden boolean DEFAULT false NOT NULL,
    CONSTRAINT user_workspace_preferences_locale_check CHECK ((locale = ANY (ARRAY['fr'::text, 'en'::text])))
);

ALTER TABLE ONLY public.user_workspace_preferences FORCE ROW LEVEL SECURITY;

-- table: users
CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    password_hash text,
    google_subject text,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarding_completed boolean DEFAULT false NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    google_unlinked_at timestamp with time zone
);

-- comment: COLUMN users.onboarding_completed
COMMENT ON COLUMN public.users.onboarding_completed IS 'Flag par utilisateur : true quand cette personne a terminé son accueil. Remplace le gate par organisation (onboarded_at) côté application.';

-- comment: COLUMN users.last_login_at
COMMENT ON COLUMN public.users.last_login_at IS 'Dernière authentification qui a OUVERT une session pour ce compte. Survit à la session et à sa purge, contrairement à sessions.last_seen_at qui date l''activité d''une session vivante. Ni la rotation d''un refresh token natif, ni une session d''assistance staff ne l''écrivent. null = aucune connexion vue depuis que la colonne existe (aucun remplissage rétroactif).';

-- comment: COLUMN users.google_unlinked_at
COMMENT ON COLUMN public.users.google_unlinked_at IS 'Set when the user unlinked Google from the account screen: Google sign-in no longer links this account by e-mail until it is linked again explicitly.';

-- table: webhook_deliveries
CREATE TABLE public.webhook_deliveries (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    state text NOT NULL,
    event_name text,
    message_id uuid,
    run_id uuid,
    workflow_id uuid,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    CONSTRAINT webhook_deliveries_check CHECK ((((state = 'reserved'::text) AND (message_id IS NULL) AND (run_id IS NULL) AND (workflow_id IS NULL) AND (accepted_at IS NULL)) OR ((state = 'accepted'::text) AND (message_id IS NOT NULL) AND (run_id IS NOT NULL) AND (workflow_id IS NOT NULL) AND (accepted_at IS NOT NULL)))),
    CONSTRAINT webhook_deliveries_event_name_check CHECK (((event_name IS NULL) OR ((char_length(event_name) >= 1) AND (char_length(event_name) <= 200)))),
    CONSTRAINT webhook_deliveries_idempotency_key_check CHECK ((((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200)) AND (idempotency_key !~ '[[:cntrl:]]'::text))),
    CONSTRAINT webhook_deliveries_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT webhook_deliveries_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'accepted'::text])))
);

ALTER TABLE ONLY public.webhook_deliveries FORCE ROW LEVEL SECURITY;

-- table: webhook_endpoints
CREATE TABLE public.webhook_endpoints (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    created_by_user_id uuid,
    name text NOT NULL,
    instructions text NOT NULL,
    secret_hash text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    delivery_count bigint DEFAULT 0 NOT NULL,
    last_received_at timestamp with time zone,
    rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhook_endpoints_delivery_count_check CHECK ((delivery_count >= 0)),
    CONSTRAINT webhook_endpoints_instructions_check CHECK (((char_length(instructions) >= 1) AND (char_length(instructions) <= 20000))),
    CONSTRAINT webhook_endpoints_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT webhook_endpoints_secret_hash_check CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.webhook_endpoints FORCE ROW LEVEL SECURITY;

-- table: workflows
CREATE TABLE public.workflows (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    root_run_id uuid NOT NULL,
    root_bot_id uuid,
    initiator_user_id uuid,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    protocol_version smallint DEFAULT 1 NOT NULL,
    autonomy_enabled boolean DEFAULT false NOT NULL,
    max_depth integer DEFAULT 3 NOT NULL,
    max_steps integer DEFAULT 8 NOT NULL,
    max_handoffs integer DEFAULT 4 NOT NULL,
    timeout_seconds integer DEFAULT 1800 NOT NULL,
    token_budget bigint DEFAULT 50000 NOT NULL,
    used_steps integer DEFAULT 0 NOT NULL,
    used_handoffs integer DEFAULT 0 NOT NULL,
    used_tokens bigint DEFAULT 0 NOT NULL,
    deadline_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    final_output text,
    error_code text,
    error_message text,
    recovery_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notification_sequence bigint DEFAULT 0 NOT NULL,
    never_wait boolean DEFAULT false NOT NULL,
    plan_only boolean DEFAULT false NOT NULL,
    CONSTRAINT workflows_kind_check CHECK ((kind = ANY (ARRAY['dm'::text, 'group'::text, 'routine'::text]))),
    CONSTRAINT workflows_max_depth_check CHECK (((max_depth >= 1) AND (max_depth <= 4))),
    CONSTRAINT workflows_max_handoffs_check CHECK (((max_handoffs >= 0) AND (max_handoffs <= 8))),
    CONSTRAINT workflows_max_steps_check CHECK (((max_steps >= 1) AND (max_steps <= 18))),
    CONSTRAINT workflows_notification_sequence_check CHECK ((notification_sequence >= 0)),
    CONSTRAINT workflows_protocol_version_check CHECK (((protocol_version >= 1) AND (protocol_version <= 32767))),
    CONSTRAINT workflows_recovery_state_check CHECK ((jsonb_typeof(recovery_state) = 'object'::text)),
    CONSTRAINT workflows_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_approval'::text, 'reconciling'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'expired'::text, 'unknown'::text]))),
    CONSTRAINT workflows_timeout_seconds_check CHECK (((timeout_seconds >= 60) AND (timeout_seconds <= 3600))),
    CONSTRAINT workflows_token_budget_check CHECK (((token_budget >= 1000) AND (token_budget <= 200000))),
    CONSTRAINT workflows_used_handoffs_check CHECK ((used_handoffs >= 0)),
    CONSTRAINT workflows_used_handoffs_within_budget CHECK ((used_handoffs <= max_handoffs)),
    CONSTRAINT workflows_used_steps_check CHECK ((used_steps >= 0)),
    CONSTRAINT workflows_used_steps_within_budget CHECK ((used_steps <= max_steps)),
    CONSTRAINT workflows_used_tokens_check CHECK ((used_tokens >= 0))
);

ALTER TABLE ONLY public.workflows FORCE ROW LEVEL SECURITY;

-- comment: COLUMN workflows.plan_only
COMMENT ON COLUMN public.workflows.plan_only IS 'The message that opened this workflow asked for a plan only: every run of the workflow is decided as `plan`. Set at insert, never changed.';

-- table: workspace_activation
CREATE TABLE public.workspace_activation (
    organization_id uuid NOT NULL,
    machine boolean DEFAULT false NOT NULL,
    model boolean DEFAULT false NOT NULL,
    bot boolean DEFAULT false NOT NULL,
    result boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.workspace_activation FORCE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('0003_tables') ON CONFLICT DO NOTHING;

COMMIT;
