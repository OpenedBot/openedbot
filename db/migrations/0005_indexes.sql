-- Baseline 5 of 10, generated from the schema of migrations 0001 to 0192.
-- Indexes.

BEGIN;

-- index: alert_channels_org_idx
CREATE INDEX alert_channels_org_idx ON public.alert_channels USING btree (organization_id, created_at);

-- index: alert_deliveries_alert_idx
CREATE INDEX alert_deliveries_alert_idx ON public.alert_deliveries USING btree (alert_id);

-- index: alert_deliveries_claimable_idx
CREATE INDEX alert_deliveries_claimable_idx ON public.alert_deliveries USING btree (available_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));

-- index: api_errors_occurred_idx
CREATE INDEX api_errors_occurred_idx ON public.api_errors USING btree (occurred_at DESC);

-- index: api_errors_org_occurred_idx
CREATE INDEX api_errors_org_occurred_idx ON public.api_errors USING btree (organization_id, occurred_at DESC) WHERE (organization_id IS NOT NULL);

-- index: apns_deliveries_claimable_idx
CREATE INDEX apns_deliveries_claimable_idx ON public.apns_deliveries USING btree (available_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));

-- index: apns_deliveries_device_idx
CREATE INDEX apns_deliveries_device_idx ON public.apns_deliveries USING btree (organization_id, device_id);

-- index: apns_devices_active_token_idx
CREATE UNIQUE INDEX apns_devices_active_token_idx ON public.apns_devices USING btree (token_hash) WHERE (revoked_at IS NULL);

-- index: apns_devices_org_active_idx
CREATE INDEX apns_devices_org_active_idx ON public.apns_devices USING btree (organization_id, created_at) WHERE (revoked_at IS NULL);

-- index: approval_requests_decision_idx
CREATE UNIQUE INDEX approval_requests_decision_idx ON public.approval_requests USING btree (organization_id, decision_id) WHERE (decision_id IS NOT NULL);

-- index: approval_requests_forward_claim_idx
CREATE INDEX approval_requests_forward_claim_idx ON public.approval_requests USING btree (forwarding_lease_expires_at, created_at) WHERE (forward_state = ANY (ARRAY['ready'::text, 'sending'::text]));

-- index: approval_requests_one_active_gate_per_run_idx
CREATE UNIQUE INDEX approval_requests_one_active_gate_per_run_idx ON public.approval_requests USING btree (organization_id, run_id) WHERE (forward_state = ANY (ARRAY['pending'::text, 'ready'::text, 'sending'::text, 'ambiguous'::text]));

-- index: approval_requests_pending_count
CREATE INDEX approval_requests_pending_count ON public.approval_requests USING btree (organization_id, expires_at) WHERE ((status = 'pending'::text) AND (forward_state = 'pending'::text) AND (selected_choice IS NULL));

-- index: approval_requests_reviewing_idx
CREATE INDEX approval_requests_reviewing_idx ON public.approval_requests USING btree (created_at) WHERE ((decision_state = 'reviewing'::text) AND (status = 'pending'::text));

-- index: approval_requests_run_gate_ordinal_idx
CREATE INDEX approval_requests_run_gate_ordinal_idx ON public.approval_requests USING btree (organization_id, run_id, gate_ordinal);

-- index: attachments_quota_idx
CREATE INDEX attachments_quota_idx ON public.attachments USING btree (organization_id) WHERE (deleted_at IS NULL);

-- index: audit_chain_organization_idx
CREATE INDEX audit_chain_organization_idx ON public.audit_chain USING btree (organization_id, runtime_id, seq);

-- index: audit_worm_orphans_organization_idx
CREATE INDEX audit_worm_orphans_organization_idx ON public.audit_worm_orphans USING btree (organization_id, detected_at);

-- index: bot_host_cleanup_active_bot_idx
CREATE UNIQUE INDEX bot_host_cleanup_active_bot_idx ON public.bot_host_cleanups USING btree (organization_id, bot_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'failed'::text]));

-- index: bot_host_cleanup_claim_idx
CREATE INDEX bot_host_cleanup_claim_idx ON public.bot_host_cleanups USING btree (next_attempt_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: bot_permission_grants_active_idx
CREATE UNIQUE INDEX bot_permission_grants_active_idx ON public.bot_permission_grants USING btree (organization_id, bot_id, tool_key) WHERE (status = 'active'::text);

-- index: bot_permission_rules_scope_idx
CREATE INDEX bot_permission_rules_scope_idx ON public.bot_permission_rules USING btree (organization_id, bot_id, kind, created_at);

-- index: bot_permission_rules_text_idx
CREATE UNIQUE INDEX bot_permission_rules_text_idx ON public.bot_permission_rules USING btree (organization_id, COALESCE(bot_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(text));

-- index: bot_profile_provision_claim_idx
CREATE INDEX bot_profile_provision_claim_idx ON public.bot_profile_provisions USING btree (next_attempt_at, bot_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: bot_setting_proposals_pending_bot_idx
CREATE INDEX bot_setting_proposals_pending_bot_idx ON public.bot_setting_proposals USING btree (organization_id, bot_id) WHERE (status = 'pending'::text);

-- index: bot_setting_proposals_thread_idx
CREATE INDEX bot_setting_proposals_thread_idx ON public.bot_setting_proposals USING btree (organization_id, thread_id);

-- index: bots_creation_request_idx
CREATE UNIQUE INDEX bots_creation_request_idx ON public.bots USING btree (organization_id, creation_request_id) WHERE (creation_request_id IS NOT NULL);

-- index: bots_deleted_at_idx
CREATE INDEX bots_deleted_at_idx ON public.bots USING btree (organization_id, deleted_at) WHERE (deleted_at IS NOT NULL);

-- index: decisions_organization_chain_sequence_idx
CREATE UNIQUE INDEX decisions_organization_chain_sequence_idx ON public.decisions USING btree (organization_id, chain_sequence);

-- index: email_login_codes_email_idx
CREATE INDEX email_login_codes_email_idx ON public.email_login_codes USING btree (email, created_at DESC);

-- index: email_outbox_claimable_idx
CREATE INDEX email_outbox_claimable_idx ON public.email_outbox USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));

-- index: email_outbox_events_recent_idx
CREATE INDEX email_outbox_events_recent_idx ON public.email_outbox_events USING btree (occurred_at DESC);

-- index: email_outbox_recent_delivery_failure_idx
CREATE INDEX email_outbox_recent_delivery_failure_idx ON public.email_outbox USING btree (last_delivery_failure_at) WHERE ((kind = ANY (ARRAY['email_login_code'::text, 'staff_login_code'::text])) AND (last_delivery_failure_at IS NOT NULL));

-- index: execution_commands_active_subject_idx
CREATE UNIQUE INDEX execution_commands_active_subject_idx ON public.execution_commands USING btree (organization_id, kind, thread_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: execution_commands_claim_idx
CREATE INDEX execution_commands_claim_idx ON public.execution_commands USING btree (created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: execution_commands_finished_idx
CREATE INDEX execution_commands_finished_idx ON public.execution_commands USING btree (finished_at) WHERE (finished_at IS NOT NULL);

-- index: execution_commands_idempotency_idx
CREATE UNIQUE INDEX execution_commands_idempotency_idx ON public.execution_commands USING btree (organization_id, requested_by_user_id, kind, idempotency_key) WHERE (idempotency_key IS NOT NULL);

-- index: marketplace_entries_published_idx
CREATE INDEX marketplace_entries_published_idx ON public.marketplace_entries USING btree (kind, title) WHERE (status = 'published'::text);

-- index: membership_events_timeline
CREATE INDEX membership_events_timeline ON public.membership_events USING btree (organization_id, occurred_at DESC);

-- index: message_ingress_expiry_idx
CREATE INDEX message_ingress_expiry_idx ON public.message_ingress USING btree (expires_at);

-- index: message_ingress_reservations_idx
CREATE INDEX message_ingress_reservations_idx ON public.message_ingress USING btree (reservation_lease_expires_at, created_at) WHERE (state = 'reserved'::text);

-- index: message_reactions_message_idx
CREATE INDEX message_reactions_message_idx ON public.message_reactions USING btree (organization_id, thread_id, message_id, emoji);

-- index: message_versions_parent_idx
CREATE INDEX message_versions_parent_idx ON public.message_versions USING btree (organization_id, parent_thread_id, parent_message_id);

-- index: messages_global_search_idx
CREATE INDEX messages_global_search_idx ON public.messages USING gin (to_tsvector('simple'::regconfig, public.openedbot_visible_message_search_text(content)));

-- index: messages_tenant_thread_id_idx
CREATE UNIQUE INDEX messages_tenant_thread_id_idx ON public.messages USING btree (organization_id, thread_id, id);

-- index: messages_thread_created_idx
CREATE INDEX messages_thread_created_idx ON public.messages USING btree (organization_id, thread_id, created_at);

-- index: messages_thread_sequence_idx
CREATE UNIQUE INDEX messages_thread_sequence_idx ON public.messages USING btree (organization_id, thread_id, sequence);

-- index: messages_thread_standalone_history_idx
CREATE INDEX messages_thread_standalone_history_idx ON public.messages USING btree (organization_id, thread_id, created_at DESC, id DESC) WHERE (run_id IS NULL);

-- index: mobile_connect_tickets_expiry
CREATE INDEX mobile_connect_tickets_expiry ON public.mobile_connect_tickets USING btree (expires_at);

-- index: oauth_attempts_expiry_idx
CREATE INDEX oauth_attempts_expiry_idx ON public.oauth_attempts USING btree (expires_at);

-- index: organization_member_invitations_pending_email
CREATE UNIQUE INDEX organization_member_invitations_pending_email ON public.organization_member_invitations USING btree (organization_id, email) WHERE (status = 'pending'::text);

-- index: profile_delete_claim_idx
CREATE INDEX profile_delete_claim_idx ON public.profile_delete_jobs USING btree (created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: profile_delete_history_idx
CREATE INDEX profile_delete_history_idx ON public.profile_delete_jobs USING btree (organization_id, created_at DESC, id DESC);

-- index: profile_delete_one_active_idx
CREATE UNIQUE INDEX profile_delete_one_active_idx ON public.profile_delete_jobs USING btree (organization_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: profile_import_claim_idx
CREATE INDEX profile_import_claim_idx ON public.profile_import_jobs USING btree (created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: profile_import_history_idx
CREATE INDEX profile_import_history_idx ON public.profile_import_jobs USING btree (organization_id, created_at DESC, id DESC);

-- index: profile_import_one_active_idx
CREATE UNIQUE INDEX profile_import_one_active_idx ON public.profile_import_jobs USING btree (organization_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: profile_import_reserved_name_idx
CREATE UNIQUE INDEX profile_import_reserved_name_idx ON public.profile_import_items USING btree (organization_id, slug) WHERE (reservation_released_at IS NULL);

-- index: push_deliveries_subscription_idx
CREATE INDEX push_deliveries_subscription_idx ON public.push_deliveries USING btree (subscription_id, created_at DESC);

-- index: push_outbox_claimable_idx
CREATE INDEX push_outbox_claimable_idx ON public.push_outbox USING btree (available_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));

-- index: push_subscriptions_org_active_idx
CREATE INDEX push_subscriptions_org_active_idx ON public.push_subscriptions USING btree (organization_id, created_at DESC) WHERE (failed_at IS NULL);

-- index: push_subscriptions_user_idx
CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions USING btree (organization_id, user_id, created_at DESC);

-- index: routine_executions_routine_idx
CREATE INDEX routine_executions_routine_idx ON public.routine_executions USING btree (organization_id, routine_id, created_at DESC, id DESC);

-- index: routines_bot_idx
CREATE INDEX routines_bot_idx ON public.routines USING btree (organization_id, bot_id, created_at);

-- index: routines_due_idx
CREATE INDEX routines_due_idx ON public.routines USING btree (next_run_at) WHERE (enabled AND (next_run_at IS NOT NULL));

-- index: routines_group_idx
CREATE INDEX routines_group_idx ON public.routines USING btree (organization_id, group_id, created_at) WHERE (group_id IS NOT NULL);

-- index: run_events_tenant_cursor_idx
CREATE INDEX run_events_tenant_cursor_idx ON public.run_events USING btree (organization_id, cursor);

-- index: run_events_thread_occurred_idx
CREATE INDEX run_events_thread_occurred_idx ON public.run_events USING btree (organization_id, thread_id, occurred_at DESC);

-- index: run_steering_source_ambiguous_idx
CREATE INDEX run_steering_source_ambiguous_idx ON public.run_steering_attempts USING btree (organization_id, source_run_id) WHERE (status = 'ambiguous'::text);

-- index: run_steering_target_pending_idx
CREATE INDEX run_steering_target_pending_idx ON public.run_steering_attempts USING btree (organization_id, target_run_id, available_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'sending'::text]));

-- index: runs_execution_session_key_idx
CREATE INDEX runs_execution_session_key_idx ON public.runs USING btree (organization_id, execution_session_key, created_at) WHERE (execution_session_key IS NOT NULL);

-- index: runs_lease_idx
CREATE INDEX runs_lease_idx ON public.runs USING btree (lease_expires_at) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'awaiting_approval'::text, 'unknown'::text]));

-- index: runs_one_active_per_thread_idx
CREATE UNIQUE INDEX runs_one_active_per_thread_idx ON public.runs USING btree (organization_id, thread_id) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'awaiting_approval'::text, 'relaying'::text, 'unknown'::text]));

-- index: runs_org_effective_time_idx
CREATE INDEX runs_org_effective_time_idx ON public.runs USING btree (organization_id, COALESCE(ended_at, created_at));

-- index: runs_organization_bot_idx
CREATE INDEX runs_organization_bot_idx ON public.runs USING btree (organization_id, bot_id) WHERE (bot_id IS NOT NULL);

-- index: runs_queue_idx
CREATE INDEX runs_queue_idx ON public.runs USING btree (status, created_at) WHERE (status = 'queued'::text);

-- index: runs_queued_deadline_idx
CREATE INDEX runs_queued_deadline_idx ON public.runs USING btree (deadline_at) WHERE ((status = 'queued'::text) AND (workflow_id IS NULL) AND (deadline_at IS NOT NULL));

-- index: runs_reconciliation_idx
CREATE INDEX runs_reconciliation_idx ON public.runs USING btree (updated_at, organization_id) WHERE ((status = 'unknown'::text) OR (external_state = 'ambiguous'::text) OR (events_complete = false) OR (remote_stop_state = ANY (ARRAY['ambiguous'::text, 'failed'::text])));

-- index: runs_remote_stop_idx
CREATE INDEX runs_remote_stop_idx ON public.runs USING btree (updated_at, organization_id) WHERE (remote_stop_state = ANY (ARRAY['requested'::text, 'ambiguous'::text, 'failed'::text]));

-- index: runs_thread_history_idx
CREATE INDEX runs_thread_history_idx ON public.runs USING btree (organization_id, thread_id, created_at DESC, id DESC);

-- index: runs_thread_live_history_idx
CREATE INDEX runs_thread_live_history_idx ON public.runs USING btree (organization_id, thread_id, id) WHERE ((ended_at IS NULL) OR (status = 'unknown'::text) OR (external_state = 'ambiguous'::text));

-- index: runs_thread_queue_idx
CREATE INDEX runs_thread_queue_idx ON public.runs USING btree (organization_id, thread_id, created_at, id) WHERE (status = 'queued'::text);

-- index: runs_workflow_created_idx
CREATE INDEX runs_workflow_created_idx ON public.runs USING btree (organization_id, workflow_id, created_at) WHERE (workflow_id IS NOT NULL);

-- index: runs_workflow_step_idx
CREATE UNIQUE INDEX runs_workflow_step_idx ON public.runs USING btree (organization_id, workflow_id, step_index) WHERE ((workflow_id IS NOT NULL) AND (step_index IS NOT NULL));

-- index: runtime_a2a_audit_page_idx
CREATE INDEX runtime_a2a_audit_page_idx ON public.runtime_a2a_audit USING btree (organization_id, runtime_id, source, source_offset DESC);

-- index: runtime_a2a_audit_time_page_idx
CREATE INDEX runtime_a2a_audit_time_page_idx ON public.runtime_a2a_audit USING btree (organization_id, runtime_id, ts DESC, source DESC, source_offset DESC);

-- index: runtime_audit_keys_current_idx
CREATE UNIQUE INDEX runtime_audit_keys_current_idx ON public.runtime_audit_keys USING btree (runtime_id) WHERE (retired_at IS NULL);

-- index: runtime_audit_verifications_recent_idx
CREATE INDEX runtime_audit_verifications_recent_idx ON public.runtime_audit_verifications USING btree (organization_id, runtime_id, received_at DESC, id DESC);

-- index: runtime_connector_notices_pending_idx
CREATE INDEX runtime_connector_notices_pending_idx ON public.runtime_connector_notices USING btree (created_at) WHERE (push_status = 'pending'::text);

-- index: runtime_direct_exposures_cleanup_idx
CREATE INDEX runtime_direct_exposures_cleanup_idx ON public.runtime_direct_exposures USING btree (last_checked_at NULLS FIRST) WHERE ((kind = 'managed_cloudflare'::text) AND (status = 'revoked'::text) AND (cleanup_status = 'pending'::text));

-- index: runtime_direct_exposures_managed_hostname_idx
CREATE UNIQUE INDEX runtime_direct_exposures_managed_hostname_idx ON public.runtime_direct_exposures USING btree (hostname) WHERE ((kind = 'managed_cloudflare'::text) AND (revoked_at IS NULL));

-- index: runtime_direct_exposures_org_idx
CREATE INDEX runtime_direct_exposures_org_idx ON public.runtime_direct_exposures USING btree (organization_id, created_at DESC);

-- index: runtime_direct_exposures_reconcile_idx
CREATE INDEX runtime_direct_exposures_reconcile_idx ON public.runtime_direct_exposures USING btree (last_checked_at NULLS FIRST) WHERE ((kind = 'managed_cloudflare'::text) AND (revoked_at IS NULL));

-- index: runtime_enrollments_expiry
CREATE INDEX runtime_enrollments_expiry ON public.runtime_enrollments USING btree (expires_at);

-- index: runtime_enrollments_pending_by_ip
CREATE INDEX runtime_enrollments_pending_by_ip ON public.runtime_enrollments USING btree (created_ip, created_at);

-- index: runtime_link_alerts_one_open_idx
CREATE UNIQUE INDEX runtime_link_alerts_one_open_idx ON public.runtime_link_alerts USING btree (runtime_id) WHERE (status = 'open'::text);

-- index: runtime_link_alerts_opened_idx
CREATE INDEX runtime_link_alerts_opened_idx ON public.runtime_link_alerts USING btree (opened_at DESC);

-- index: runtime_link_diagnostics_recent_idx
CREATE INDEX runtime_link_diagnostics_recent_idx ON public.runtime_link_diagnostics USING btree (organization_id, runtime_id, received_at DESC, id DESC);

-- index: runtime_link_dispatches_hash_idx
CREATE INDEX runtime_link_dispatches_hash_idx ON public.runtime_link_dispatches USING btree (runtime_id, idempotency_key_hash);

-- index: runtime_link_dispatches_recent_idx
CREATE INDEX runtime_link_dispatches_recent_idx ON public.runtime_link_dispatches USING btree (organization_id, runtime_id, dispatched_at DESC);

-- index: runtime_link_events_runtime_idx
CREATE INDEX runtime_link_events_runtime_idx ON public.runtime_link_events USING btree (organization_id, runtime_id, occurred_at DESC);

-- index: runtime_model_selection_proof_claim_idx
CREATE INDEX runtime_model_selection_proof_claim_idx ON public.runtime_model_selection_proofs USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- index: runtime_provider_incidents_active_idx
CREATE INDEX runtime_provider_incidents_active_idx ON public.runtime_provider_incidents USING btree (organization_id, runtime_id, until);

-- index: runtime_provider_incidents_runtime_provider_idx
CREATE INDEX runtime_provider_incidents_runtime_provider_idx ON public.runtime_provider_incidents USING btree (runtime_id, provider);

-- index: runtime_review_profiles_due_idx
CREATE INDEX runtime_review_profiles_due_idx ON public.runtime_review_profiles USING btree (next_check_at);

-- index: runtimes_one_active_per_org
CREATE UNIQUE INDEX runtimes_one_active_per_org ON public.runtimes USING btree (organization_id) WHERE is_active;

-- index: sessions_owner_idx
CREATE INDEX sessions_owner_idx ON public.sessions USING btree (user_id, created_at DESC);

-- index: staff_impersonation_claims_staff_idx
CREATE INDEX staff_impersonation_claims_staff_idx ON public.staff_impersonation_claims USING btree (staff_user_id, created_at DESC);

-- index: staff_login_codes_user_idx
CREATE INDEX staff_login_codes_user_idx ON public.staff_login_codes USING btree (staff_user_id, created_at DESC);

-- index: staff_sessions_user_idx
CREATE INDEX staff_sessions_user_idx ON public.staff_sessions USING btree (staff_user_id, created_at DESC);

-- index: staff_users_email_unique_idx
CREATE UNIQUE INDEX staff_users_email_unique_idx ON public.staff_users USING btree (lower(email));

-- index: support_attachments_message_idx
CREATE INDEX support_attachments_message_idx ON public.support_attachments USING btree (message_id);

-- index: support_conversations_email_lower_idx
CREATE INDEX support_conversations_email_lower_idx ON public.support_conversations USING btree (lower(email));

-- index: support_conversations_status_idx
CREATE INDEX support_conversations_status_idx ON public.support_conversations USING btree (status, last_guest_message_at DESC NULLS LAST, created_at DESC);

-- index: support_conversations_user_idx
CREATE INDEX support_conversations_user_idx ON public.support_conversations USING btree (user_id, updated_at DESC) WHERE (user_id IS NOT NULL);

-- index: support_events_conversation_cursor_idx
CREATE INDEX support_events_conversation_cursor_idx ON public.support_events USING btree (conversation_id, cursor);

-- index: support_messages_idempotency_idx
CREATE UNIQUE INDEX support_messages_idempotency_idx ON public.support_messages USING btree (conversation_id, author, idempotency_key) WHERE (idempotency_key IS NOT NULL);

-- index: support_messages_thread_idx
CREATE INDEX support_messages_thread_idx ON public.support_messages USING btree (conversation_id, created_at, id);

-- index: team_imports_created_idx
CREATE INDEX team_imports_created_idx ON public.team_imports USING btree (organization_id, created_at DESC, id DESC);

-- index: tenant_blob_deletions_claimable_idx
CREATE INDEX tenant_blob_deletions_claimable_idx ON public.tenant_blob_deletions USING btree (available_at, created_at);

-- index: tenant_deletions_claimable_idx
CREATE INDEX tenant_deletions_claimable_idx ON public.tenant_deletions USING btree (requested_at) WHERE (completed_at IS NULL);

-- index: threads_bot_activity_idx
CREATE INDEX threads_bot_activity_idx ON public.threads USING btree (organization_id, bot_id, updated_at DESC, created_at DESC) WHERE (bot_id IS NOT NULL);

-- index: threads_global_search_idx
CREATE INDEX threads_global_search_idx ON public.threads USING gin (to_tsvector('simple'::regconfig, public.openedbot_global_search_normalize(COALESCE(title, ''::text))));

-- index: threads_one_default_task_per_bot_idx
CREATE UNIQUE INDEX threads_one_default_task_per_bot_idx ON public.threads USING btree (organization_id, bot_id) WHERE ((bot_id IS NOT NULL) AND is_default);

-- index: tool_errors_bot_occurred_idx
CREATE INDEX tool_errors_bot_occurred_idx ON public.tool_errors USING btree (organization_id, bot_id, occurred_at DESC, id DESC);

-- index: tool_errors_org_occurred_idx
CREATE INDEX tool_errors_org_occurred_idx ON public.tool_errors USING btree (organization_id, occurred_at DESC);

-- index: users_email_unique_idx
CREATE UNIQUE INDEX users_email_unique_idx ON public.users USING btree (lower(email));

-- index: webhook_deliveries_endpoint_received_idx
CREATE INDEX webhook_deliveries_endpoint_received_idx ON public.webhook_deliveries USING btree (organization_id, endpoint_id, received_at DESC);

-- index: webhook_endpoints_thread_idx
CREATE INDEX webhook_endpoints_thread_idx ON public.webhook_endpoints USING btree (organization_id, thread_id, created_at DESC) WHERE (deleted_at IS NULL);

-- index: webhook_management_operations_recovery_idx
CREATE INDEX webhook_management_operations_recovery_idx ON public.webhook_management_operations USING btree (organization_id, recoverable_until) WHERE (secret_ciphertext IS NOT NULL);

-- index: workflows_deadline_idx
CREATE INDEX workflows_deadline_idx ON public.workflows USING btree (deadline_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_approval'::text, 'reconciling'::text, 'unknown'::text]));

-- index: workflows_organization_created_idx
CREATE INDEX workflows_organization_created_idx ON public.workflows USING btree (organization_id, created_at DESC, id DESC);

-- index: workflows_root_bot_created_idx
CREATE INDEX workflows_root_bot_created_idx ON public.workflows USING btree (organization_id, root_bot_id, created_at) WHERE (root_bot_id IS NOT NULL);

-- index: workflows_status_updated_idx
CREATE INDEX workflows_status_updated_idx ON public.workflows USING btree (status, updated_at);

-- index: workflows_thread_created_idx
CREATE INDEX workflows_thread_created_idx ON public.workflows USING btree (organization_id, thread_id, created_at);

INSERT INTO schema_migrations(version) VALUES ('0005_indexes') ON CONFLICT DO NOTHING;

COMMIT;
