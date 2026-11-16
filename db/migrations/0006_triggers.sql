-- Baseline 6 of 10, generated from the schema of migrations 0001 to 0192.
-- Triggers.

BEGIN;

-- trigger: apns_devices apns_devices_token_moved
CREATE TRIGGER apns_devices_token_moved BEFORE INSERT OR UPDATE OF token_hash, revoked_at ON public.apns_devices FOR EACH ROW EXECUTE FUNCTION public.revoke_moved_apns_token();

-- trigger: approval_requests approval_requests_permission_guard
CREATE TRIGGER approval_requests_permission_guard BEFORE INSERT OR UPDATE ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.approval_requests_permission_guard();

-- trigger: approval_requests approval_requests_sync_forward_state_legacy
CREATE TRIGGER approval_requests_sync_forward_state_legacy BEFORE INSERT OR UPDATE OF status, selected_choice, forwarded_at ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.sync_approval_forward_state_legacy();

-- trigger: audit_chain audit_chain_no_update
CREATE TRIGGER audit_chain_no_update BEFORE UPDATE ON public.audit_chain FOR EACH ROW EXECUTE FUNCTION public.audit_chain_append_only();

-- trigger: audit_worm_orphans audit_worm_orphans_no_update
CREATE TRIGGER audit_worm_orphans_no_update BEFORE UPDATE ON public.audit_worm_orphans FOR EACH ROW EXECUTE FUNCTION public.audit_worm_orphans_append_only();

-- trigger: bot_permission_grants bot_permission_grants_revision_insert
CREATE TRIGGER bot_permission_grants_revision_insert AFTER INSERT ON public.bot_permission_grants FOR EACH ROW EXECUTE FUNCTION public.bot_permission_grants_revision();

-- trigger: bot_permission_grants bot_permission_grants_revision_update
CREATE TRIGGER bot_permission_grants_revision_update AFTER UPDATE OF status ON public.bot_permission_grants FOR EACH ROW WHEN ((new.status IS DISTINCT FROM old.status)) EXECUTE FUNCTION public.bot_permission_grants_revision();

-- trigger: bot_permission_grants bot_permission_grants_transition
CREATE TRIGGER bot_permission_grants_transition BEFORE UPDATE ON public.bot_permission_grants FOR EACH ROW EXECUTE FUNCTION public.bot_permission_grants_transition();

-- trigger: bot_permission_rules bot_permission_rules_limit
CREATE TRIGGER bot_permission_rules_limit BEFORE INSERT ON public.bot_permission_rules FOR EACH ROW EXECUTE FUNCTION public.bot_permission_rules_limit();

-- trigger: bot_permission_rules bot_permission_rules_revision
CREATE TRIGGER bot_permission_rules_revision AFTER INSERT OR DELETE ON public.bot_permission_rules FOR EACH ROW EXECUTE FUNCTION public.bot_permission_rules_revision();

-- trigger: bot_permission_tool_policies bot_permission_tool_policies_revision
CREATE TRIGGER bot_permission_tool_policies_revision AFTER INSERT OR DELETE OR UPDATE ON public.bot_permission_tool_policies FOR EACH ROW EXECUTE FUNCTION public.bot_permission_tool_policies_revision();

-- trigger: bots bots_permission_ceiling_guard
CREATE TRIGGER bots_permission_ceiling_guard BEFORE INSERT OR UPDATE OF permission_mode ON public.bots FOR EACH ROW EXECUTE FUNCTION public.bots_permission_ceiling_guard();

-- trigger: bots bots_permission_revision
CREATE TRIGGER bots_permission_revision BEFORE UPDATE ON public.bots FOR EACH ROW EXECUTE FUNCTION public.bots_raise_permission_revision();

-- trigger: email_outbox email_outbox_delivery_failure_stamp
CREATE TRIGGER email_outbox_delivery_failure_stamp BEFORE INSERT OR UPDATE OF status, attempts, last_error ON public.email_outbox FOR EACH ROW EXECUTE FUNCTION public.stamp_email_delivery_failure();

-- trigger: memberships memberships_closing_account
CREATE TRIGGER memberships_closing_account BEFORE INSERT OR UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.guard_closing_account_membership();

-- trigger: memberships memberships_drop_apns_devices
CREATE TRIGGER memberships_drop_apns_devices AFTER UPDATE OF revoked_at ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.drop_apns_devices_of_revoked_member();

-- trigger: memberships memberships_drop_push_subscriptions
CREATE TRIGGER memberships_drop_push_subscriptions AFTER UPDATE OF revoked_at ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.drop_push_subscriptions_of_revoked_member();

-- trigger: messages messages_assign_sequence_and_author
CREATE TRIGGER messages_assign_sequence_and_author BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.assign_message_sequence_and_author();

-- trigger: mobile_connect_tickets mobile_tickets_erased_account
CREATE TRIGGER mobile_tickets_erased_account BEFORE INSERT ON public.mobile_connect_tickets FOR EACH ROW EXECUTE FUNCTION public.guard_erased_account_session();

-- trigger: bot_profile_provisions mvp_activation_bot
CREATE TRIGGER mvp_activation_bot AFTER INSERT OR UPDATE ON public.bot_profile_provisions FOR EACH ROW EXECUTE FUNCTION public.record_workspace_activation();

-- trigger: runtime_model_proven mvp_activation_model
CREATE TRIGGER mvp_activation_model AFTER INSERT ON public.runtime_model_proven FOR EACH ROW EXECUTE FUNCTION public.record_workspace_activation();

-- trigger: workflows mvp_activation_result
CREATE TRIGGER mvp_activation_result AFTER INSERT OR UPDATE OF status ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.record_workspace_activation();

-- trigger: runtimes mvp_activation_runtime
CREATE TRIGGER mvp_activation_runtime AFTER INSERT OR UPDATE ON public.runtimes FOR EACH ROW EXECUTE FUNCTION public.record_workspace_activation();

-- trigger: native_auth_codes native_codes_erased_account
CREATE TRIGGER native_codes_erased_account BEFORE INSERT ON public.native_auth_codes FOR EACH ROW EXECUTE FUNCTION public.guard_erased_account_session();

-- trigger: organization_permission_policies organization_permission_policies_revision
CREATE TRIGGER organization_permission_policies_revision AFTER INSERT OR UPDATE ON public.organization_permission_policies FOR EACH ROW EXECUTE FUNCTION public.organization_permission_policies_revision();

-- trigger: organizations organizations_permission_pipeline_revision
CREATE TRIGGER organizations_permission_pipeline_revision AFTER UPDATE OF permission_pipeline ON public.organizations FOR EACH ROW WHEN ((new.permission_pipeline IS DISTINCT FROM old.permission_pipeline)) EXECUTE FUNCTION public.organizations_permission_pipeline_revision();

-- trigger: push_subscriptions push_subscriptions_reassign
CREATE TRIGGER push_subscriptions_reassign BEFORE INSERT OR UPDATE OF endpoint ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.reassign_push_endpoint();

-- trigger: run_events run_events_notify
CREATE TRIGGER run_events_notify AFTER INSERT ON public.run_events FOR EACH ROW EXECUTE FUNCTION public.notify_openedbot_event();

-- trigger: run_events run_events_stamp_identity
CREATE TRIGGER run_events_stamp_identity BEFORE INSERT ON public.run_events FOR EACH ROW EXECUTE FUNCTION public.run_events_stamp_identity();

-- trigger: runs runs_final_status
CREATE TRIGGER runs_final_status BEFORE UPDATE OF status ON public.runs FOR EACH ROW WHEN (((old.status = ANY (ARRAY['completed'::text, 'failed'::text])) AND (new.status IS DISTINCT FROM old.status))) EXECUTE FUNCTION public.guard_run_final_status();

-- trigger: runs runs_queue_wakeup
CREATE TRIGGER runs_queue_wakeup AFTER INSERT OR UPDATE OF status, next_attempt_at, lease_owner, remote_stop_state ON public.runs FOR EACH ROW EXECUTE FUNCTION public.notify_worker_run_queue();

-- trigger: runs runs_unknown_review_workflow
CREATE TRIGGER runs_unknown_review_workflow BEFORE UPDATE OF status ON public.runs FOR EACH ROW EXECUTE FUNCTION public.open_unknown_run_review_workflow();

-- trigger: runtime_link_events runtime_link_events_change_notify
CREATE TRIGGER runtime_link_events_change_notify AFTER INSERT ON public.runtime_link_events FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['replaced'::text, 'hijack_suspected'::text]))) EXECUTE FUNCTION public.notify_openedbot_runtime_child();

-- trigger: runtime_permission_settings runtime_permission_settings_revision_insert
CREATE TRIGGER runtime_permission_settings_revision_insert AFTER INSERT ON public.runtime_permission_settings FOR EACH ROW EXECUTE FUNCTION public.runtime_permission_settings_revision();

-- trigger: runtime_permission_settings runtime_permission_settings_revision_update
CREATE TRIGGER runtime_permission_settings_revision_update AFTER UPDATE OF terminal_danger_always ON public.runtime_permission_settings FOR EACH ROW WHEN ((new.terminal_danger_always IS DISTINCT FROM old.terminal_danger_always)) EXECUTE FUNCTION public.runtime_permission_settings_revision();

-- trigger: runtime_provider_incidents runtime_provider_incidents_change_notify
CREATE TRIGGER runtime_provider_incidents_change_notify AFTER UPDATE ON public.runtime_provider_incidents FOR EACH ROW WHEN ((((((old.kind IS DISTINCT FROM new.kind) OR (old.fallback_provider IS DISTINCT FROM new.fallback_provider)) OR (old.fallback_model IS DISTINCT FROM new.fallback_model)) OR (old.message IS DISTINCT FROM new.message)) OR ((old.until > now()) IS DISTINCT FROM (new.until > now())))) EXECUTE FUNCTION public.notify_openedbot_runtime_child();

-- trigger: runtime_provider_incidents runtime_provider_incidents_change_notify_rows
CREATE TRIGGER runtime_provider_incidents_change_notify_rows AFTER INSERT OR DELETE ON public.runtime_provider_incidents FOR EACH ROW EXECUTE FUNCTION public.notify_openedbot_runtime_child();

-- trigger: runtime_review_profiles runtime_review_profiles_change_notify
CREATE TRIGGER runtime_review_profiles_change_notify AFTER UPDATE ON public.runtime_review_profiles FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR ((old.proven_at > (now() - '00:10:00'::interval)) IS DISTINCT FROM (new.proven_at > (now() - '00:10:00'::interval))))) EXECUTE FUNCTION public.notify_openedbot_runtime_child();

-- trigger: runtime_review_profiles runtime_review_profiles_change_notify_rows
CREATE TRIGGER runtime_review_profiles_change_notify_rows AFTER INSERT OR DELETE ON public.runtime_review_profiles FOR EACH ROW EXECUTE FUNCTION public.notify_openedbot_runtime_child();

-- trigger: runtimes runtimes_change_notify
CREATE TRIGGER runtimes_change_notify AFTER UPDATE ON public.runtimes FOR EACH ROW WHEN (((((((((((((((((((((old.name IS DISTINCT FROM new.name) OR (old.endpoint IS DISTINCT FROM new.endpoint)) OR (old.capacity IS DISTINCT FROM new.capacity)) OR (old.revoked_at IS DISTINCT FROM new.revoked_at)) OR (old.is_active IS DISTINCT FROM new.is_active)) OR (old.reachability IS DISTINCT FROM new.reachability)) OR (old.last_health_status IS DISTINCT FROM new.last_health_status)) OR (old.last_health_error IS DISTINCT FROM new.last_health_error)) OR (old.selected_provider IS DISTINCT FROM new.selected_provider)) OR (old.selected_model IS DISTINCT FROM new.selected_model)) OR (old.reasoning_effort IS DISTINCT FROM new.reasoning_effort)) OR (old.link_instance_id IS DISTINCT FROM new.link_instance_id)) OR (old.link_connected_at IS DISTINCT FROM new.link_connected_at)) OR (old.link_generation IS DISTINCT FROM new.link_generation)) OR (old.link_features IS DISTINCT FROM new.link_features)) OR (old.link_agent IS DISTINCT FROM new.link_agent)) OR (old.link_hermes_version IS DISTINCT FROM new.link_hermes_version)) OR (old.link_origin IS DISTINCT FROM new.link_origin)) OR (old.link_token_rotated_at IS DISTINCT FROM new.link_token_rotated_at)) OR ((old.edge_auth_ciphertext IS NULL) IS DISTINCT FROM (new.edge_auth_ciphertext IS NULL)))) EXECUTE FUNCTION public.notify_openedbot_runtime();

-- trigger: runtimes runtimes_change_notify_rows
CREATE TRIGGER runtimes_change_notify_rows AFTER INSERT OR DELETE ON public.runtimes FOR EACH ROW EXECUTE FUNCTION public.notify_openedbot_runtime();

-- trigger: sessions sessions_erased_account
CREATE TRIGGER sessions_erased_account BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.guard_erased_account_session();

-- trigger: users users_erased_credentials
CREATE TRIGGER users_erased_credentials BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.guard_erased_account_credentials();

-- trigger: workflows workflows_email
CREATE TRIGGER workflows_email AFTER UPDATE OF status ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.enqueue_workflow_email();

-- trigger: workflows workflows_notification_sequence
CREATE TRIGGER workflows_notification_sequence BEFORE UPDATE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.advance_workflow_notification_sequence();

INSERT INTO schema_migrations(version) VALUES ('0006_triggers') ON CONFLICT DO NOTHING;

COMMIT;
