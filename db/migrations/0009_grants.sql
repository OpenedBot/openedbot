-- Baseline 9 of 10, generated from the schema of migrations 0001 to 0192.
-- Grants per application role (openedbot_api, openedbot_worker, openedbot_staff).

BEGIN;

-- acl: FUNCTION audit_chain_for_purge(org uuid)
REVOKE ALL ON FUNCTION public.audit_chain_for_purge(org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_chain_for_purge(org uuid) TO openedbot_worker;

-- acl: FUNCTION bot_permission_rules_limit()
REVOKE ALL ON FUNCTION public.bot_permission_rules_limit() FROM PUBLIC;

-- acl: FUNCTION bot_permission_rules_revision()
REVOKE ALL ON FUNCTION public.bot_permission_rules_revision() FROM PUBLIC;

-- acl: FUNCTION bot_permission_tool_policies_revision()
REVOKE ALL ON FUNCTION public.bot_permission_tool_policies_revision() FROM PUBLIC;

-- acl: FUNCTION bots_permission_ceiling_guard()
REVOKE ALL ON FUNCTION public.bots_permission_ceiling_guard() FROM PUBLIC;

-- acl: FUNCTION drop_apns_devices_of_revoked_member()
REVOKE ALL ON FUNCTION public.drop_apns_devices_of_revoked_member() FROM PUBLIC;

-- acl: FUNCTION drop_push_subscriptions_of_revoked_member()
REVOKE ALL ON FUNCTION public.drop_push_subscriptions_of_revoked_member() FROM PUBLIC;

-- acl: FUNCTION enqueue_workflow_email()
REVOKE ALL ON FUNCTION public.enqueue_workflow_email() FROM PUBLIC;

-- acl: FUNCTION erase_account_user(p_user_id uuid)
REVOKE ALL ON FUNCTION public.erase_account_user(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.erase_account_user(p_user_id uuid) TO openedbot_worker;

-- acl: FUNCTION finalize_account_closure(p_user_id uuid)
REVOKE ALL ON FUNCTION public.finalize_account_closure(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_account_closure(p_user_id uuid) TO openedbot_worker;

-- acl: FUNCTION guard_closing_account_membership()
REVOKE ALL ON FUNCTION public.guard_closing_account_membership() FROM PUBLIC;

-- acl: FUNCTION guard_erased_account_credentials()
REVOKE ALL ON FUNCTION public.guard_erased_account_credentials() FROM PUBLIC;

-- acl: FUNCTION guard_erased_account_session()
REVOKE ALL ON FUNCTION public.guard_erased_account_session() FROM PUBLIC;

-- acl: FUNCTION internal_email_delivery_metrics()
REVOKE ALL ON FUNCTION public.internal_email_delivery_metrics() FROM PUBLIC;
GRANT ALL ON FUNCTION public.internal_email_delivery_metrics() TO openedbot_api;

-- acl: FUNCTION internal_operational_metrics()
REVOKE ALL ON FUNCTION public.internal_operational_metrics() FROM PUBLIC;
GRANT ALL ON FUNCTION public.internal_operational_metrics() TO openedbot_api;

-- acl: FUNCTION lock_account_closure_user(p_user_id uuid)
REVOKE ALL ON FUNCTION public.lock_account_closure_user(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_account_closure_user(p_user_id uuid) TO openedbot_worker;

-- acl: FUNCTION open_unknown_run_review_workflow()
REVOKE ALL ON FUNCTION public.open_unknown_run_review_workflow() FROM PUBLIC;

-- acl: FUNCTION organization_permission_policies_revision()
REVOKE ALL ON FUNCTION public.organization_permission_policies_revision() FROM PUBLIC;

-- acl: FUNCTION purge_dead_sessions()
REVOKE ALL ON FUNCTION public.purge_dead_sessions() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_dead_sessions() TO openedbot_worker;

-- acl: FUNCTION purge_expired_oauth_attempts()
REVOKE ALL ON FUNCTION public.purge_expired_oauth_attempts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_expired_oauth_attempts() TO openedbot_api;

-- acl: FUNCTION purge_spent_email_login_codes()
REVOKE ALL ON FUNCTION public.purge_spent_email_login_codes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_spent_email_login_codes() TO openedbot_worker;

-- acl: FUNCTION reassign_push_endpoint()
REVOKE ALL ON FUNCTION public.reassign_push_endpoint() FROM PUBLIC;

-- acl: FUNCTION record_workspace_activation()
REVOKE ALL ON FUNCTION public.record_workspace_activation() FROM PUBLIC;

-- acl: FUNCTION revoke_moved_apns_token()
REVOKE ALL ON FUNCTION public.revoke_moved_apns_token() FROM PUBLIC;

-- acl: FUNCTION routine_tool_due_organizations(max_count integer)
REVOKE ALL ON FUNCTION public.routine_tool_due_organizations(max_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.routine_tool_due_organizations(max_count integer) TO openedbot_api;

-- acl: FUNCTION runtime_link_owner(p_runtime_id uuid)
REVOKE ALL ON FUNCTION public.runtime_link_owner(p_runtime_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.runtime_link_owner(p_runtime_id uuid) TO openedbot_api;
GRANT ALL ON FUNCTION public.runtime_link_owner(p_runtime_id uuid) TO openedbot_worker;

-- acl: FUNCTION set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint)
REVOKE ALL ON FUNCTION public.set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint) TO openedbot_api;

-- acl: FUNCTION staff_acknowledge_runtime_link_alert(p_alert uuid)
REVOKE ALL ON FUNCTION public.staff_acknowledge_runtime_link_alert(p_alert uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_acknowledge_runtime_link_alert(p_alert uuid) TO openedbot_api;

-- acl: FUNCTION staff_audit_log(p_limit integer, p_before timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_audit_log(p_limit integer, p_before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_audit_log(p_limit integer, p_before timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_audit_scope(p_organization_id uuid, p_subject_id uuid, p_limit integer, p_before timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_audit_scope(p_organization_id uuid, p_subject_id uuid, p_limit integer, p_before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_audit_scope(p_organization_id uuid, p_subject_id uuid, p_limit integer, p_before timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_closure_notice_recipients(p_limit integer)
REVOKE ALL ON FUNCTION public.staff_closure_notice_recipients(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_closure_notice_recipients(p_limit integer) TO openedbot_api;

-- acl: FUNCTION staff_get_organization(p_id uuid)
REVOKE ALL ON FUNCTION public.staff_get_organization(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_get_organization(p_id uuid) TO openedbot_api;

-- acl: FUNCTION staff_get_user(p_id uuid)
REVOKE ALL ON FUNCTION public.staff_get_user(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_get_user(p_id uuid) TO openedbot_api;

-- acl: FUNCTION staff_issue_impersonation_claim(p_id uuid, p_organization_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_issue_impersonation_claim(p_id uuid, p_organization_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_issue_impersonation_claim(p_id uuid, p_organization_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_issue_user_impersonation_claim(p_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_issue_user_impersonation_claim(p_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_issue_user_impersonation_claim(p_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_operational_metrics()
REVOKE ALL ON FUNCTION public.staff_operational_metrics() FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_operational_metrics() TO openedbot_api;

-- acl: FUNCTION staff_permission_bots(p_limit integer)
REVOKE ALL ON FUNCTION public.staff_permission_bots(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_permission_bots(p_limit integer) TO openedbot_api;

-- acl: FUNCTION staff_permission_decision_stats(p_days integer)
REVOKE ALL ON FUNCTION public.staff_permission_decision_stats(p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_permission_decision_stats(p_days integer) TO openedbot_api;

-- acl: FUNCTION staff_permission_decisions(p_stage text, p_limit integer, p_before timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_permission_decisions(p_stage text, p_limit integer, p_before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_permission_decisions(p_stage text, p_limit integer, p_before timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_permission_guard()
REVOKE ALL ON FUNCTION public.staff_permission_guard() FROM PUBLIC;

-- acl: FUNCTION staff_reset_user_password(p_user_id uuid, p_password_hash text)
REVOKE ALL ON FUNCTION public.staff_reset_user_password(p_user_id uuid, p_password_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_reset_user_password(p_user_id uuid, p_password_hash text) TO openedbot_api;

-- acl: FUNCTION staff_resolve_reference(p_term text)
REVOKE ALL ON FUNCTION public.staff_resolve_reference(p_term text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_resolve_reference(p_term text) TO openedbot_api;

-- acl: FUNCTION staff_runtime_connectors(p_limit integer)
REVOKE ALL ON FUNCTION public.staff_runtime_connectors(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_runtime_connectors(p_limit integer) TO openedbot_api;

-- acl: FUNCTION staff_runtime_link_alerts(p_status text, p_limit integer, p_before timestamp with time zone)
REVOKE ALL ON FUNCTION public.staff_runtime_link_alerts(p_status text, p_limit integer, p_before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_runtime_link_alerts(p_status text, p_limit integer, p_before timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION staff_search_users(p_query text, p_assistance text, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_email text, p_cursor_id uuid)
REVOKE ALL ON FUNCTION public.staff_search_users(p_query text, p_assistance text, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_email text, p_cursor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_search_users(p_query text, p_assistance text, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_email text, p_cursor_id uuid) TO openedbot_api;

-- acl: FUNCTION staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text)
REVOKE ALL ON FUNCTION public.staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text) TO openedbot_api;

-- acl: FUNCTION staff_user_counts()
REVOKE ALL ON FUNCTION public.staff_user_counts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_user_counts() TO openedbot_api;

-- acl: FUNCTION stamp_email_delivery_failure()
REVOKE ALL ON FUNCTION public.stamp_email_delivery_failure() FROM PUBLIC;

-- acl: FUNCTION support_notify_recipients()
REVOKE ALL ON FUNCTION public.support_notify_recipients() FROM PUBLIC;
GRANT ALL ON FUNCTION public.support_notify_recipients() TO openedbot_api;

-- acl: FUNCTION support_staff_session()
REVOKE ALL ON FUNCTION public.support_staff_session() FROM PUBLIC;
GRANT ALL ON FUNCTION public.support_staff_session() TO openedbot_api;

-- acl: FUNCTION workflow_email_recipient(payload jsonb)
REVOKE ALL ON FUNCTION public.workflow_email_recipient(payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workflow_email_recipient(payload jsonb) TO openedbot_worker;

-- acl: FUNCTION workspace_access(p_user uuid, p_org uuid)
REVOKE ALL ON FUNCTION public.workspace_access(p_user uuid, p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workspace_access(p_user uuid, p_org uuid) TO openedbot_api;

-- acl: FUNCTION workspace_business_metrics(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone, p_now timestamp with time zone)
REVOKE ALL ON FUNCTION public.workspace_business_metrics(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workspace_business_metrics(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone, p_now timestamp with time zone) TO openedbot_api;

-- acl: FUNCTION workspace_run_activity(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone)
REVOKE ALL ON FUNCTION public.workspace_run_activity(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workspace_run_activity(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone) TO openedbot_api;

-- acl: TABLE account_deletions
GRANT SELECT,INSERT,DELETE ON TABLE public.account_deletions TO openedbot_api;
GRANT SELECT,DELETE,UPDATE ON TABLE public.account_deletions TO openedbot_worker;

-- acl: COLUMN account_deletions.last_error
GRANT UPDATE(last_error) ON TABLE public.account_deletions TO openedbot_api;

-- acl: TABLE alert_channels
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.alert_channels TO openedbot_api;
GRANT SELECT,UPDATE ON TABLE public.alert_channels TO openedbot_worker;

-- acl: TABLE alert_deliveries
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.alert_deliveries TO openedbot_worker;

-- acl: TABLE api_errors
GRANT INSERT ON TABLE public.api_errors TO openedbot_api;
GRANT SELECT,DELETE ON TABLE public.api_errors TO openedbot_worker;

-- acl: TABLE api_instances
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.api_instances TO openedbot_api;
GRANT SELECT ON TABLE public.api_instances TO openedbot_worker;

-- acl: TABLE apns_deliveries
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.apns_deliveries TO openedbot_worker;

-- acl: TABLE apns_devices
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.apns_devices TO openedbot_api;
GRANT SELECT,UPDATE ON TABLE public.apns_devices TO openedbot_worker;

-- acl: TABLE approval_requests
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_requests TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_requests TO openedbot_worker;

-- acl: TABLE attachments
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attachments TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attachments TO openedbot_worker;

-- acl: TABLE audit_chain
GRANT SELECT,INSERT ON TABLE public.audit_chain TO openedbot_api;

-- acl: TABLE decisions
GRANT SELECT,INSERT ON TABLE public.decisions TO openedbot_api;

-- acl: TABLE runtime_audit_verifications
GRANT SELECT,INSERT ON TABLE public.runtime_audit_verifications TO openedbot_api;

-- acl: TABLE runtime_link_events
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_link_events TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_link_events TO openedbot_worker;

-- acl: TABLE staff_impersonation_claims
GRANT SELECT,UPDATE ON TABLE public.staff_impersonation_claims TO openedbot_api;

-- acl: TABLE webhook_management_operations
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_management_operations TO openedbot_api;

-- acl: TABLE audit_log
GRANT SELECT ON TABLE public.audit_log TO openedbot_api;

-- acl: TABLE audit_worm_orphans
GRANT SELECT,INSERT ON TABLE public.audit_worm_orphans TO openedbot_api;

-- acl: TABLE bot_groups
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_groups TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_groups TO openedbot_worker;

-- acl: TABLE bot_host_cleanups
GRANT SELECT,INSERT,UPDATE ON TABLE public.bot_host_cleanups TO openedbot_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.bot_host_cleanups TO openedbot_worker;

-- acl: TABLE bot_permission_grants
GRANT SELECT,INSERT,UPDATE ON TABLE public.bot_permission_grants TO openedbot_api;
GRANT SELECT ON TABLE public.bot_permission_grants TO openedbot_worker;

-- acl: TABLE bot_permission_rules
GRANT SELECT,INSERT,DELETE ON TABLE public.bot_permission_rules TO openedbot_api;
GRANT SELECT ON TABLE public.bot_permission_rules TO openedbot_worker;

-- acl: TABLE bot_permission_tool_policies
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_permission_tool_policies TO openedbot_api;
GRANT SELECT ON TABLE public.bot_permission_tool_policies TO openedbot_worker;

-- acl: TABLE bot_playbooks
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_playbooks TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_playbooks TO openedbot_worker;

-- acl: TABLE bot_profile_provisions
GRANT SELECT,INSERT,UPDATE ON TABLE public.bot_profile_provisions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_profile_provisions TO openedbot_worker;

-- acl: TABLE bot_routine_tools
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_routine_tools TO openedbot_api;
GRANT SELECT ON TABLE public.bot_routine_tools TO openedbot_worker;

-- acl: TABLE bot_setting_proposals
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bot_setting_proposals TO openedbot_api;

-- acl: TABLE bots
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bots TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bots TO openedbot_worker;

-- acl: TABLE email_login_codes
GRANT SELECT,INSERT,UPDATE ON TABLE public.email_login_codes TO openedbot_api;

-- acl: TABLE email_outbox
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_outbox TO openedbot_worker;
GRANT INSERT ON TABLE public.email_outbox TO openedbot_api;

-- acl: TABLE email_outbox_events
GRANT SELECT,INSERT ON TABLE public.email_outbox_events TO openedbot_api;
GRANT INSERT ON TABLE public.email_outbox_events TO openedbot_worker;

-- acl: TABLE execution_commands
GRANT SELECT,INSERT,UPDATE ON TABLE public.execution_commands TO openedbot_api;
GRANT SELECT,DELETE,UPDATE ON TABLE public.execution_commands TO openedbot_worker;

-- acl: TABLE group_member_read_positions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_member_read_positions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_member_read_positions TO openedbot_worker;

-- acl: TABLE group_members
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_members TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_members TO openedbot_worker;

-- acl: TABLE marketplace_entries
GRANT SELECT,INSERT,UPDATE ON TABLE public.marketplace_entries TO openedbot_api;

-- acl: TABLE membership_events
GRANT SELECT,INSERT ON TABLE public.membership_events TO openedbot_api;

-- acl: TABLE memberships
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memberships TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memberships TO openedbot_worker;

-- acl: TABLE message_ingress
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.message_ingress TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.message_ingress TO openedbot_worker;

-- acl: TABLE message_reactions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.message_reactions TO openedbot_api;

-- acl: TABLE message_versions
GRANT SELECT,INSERT ON TABLE public.message_versions TO openedbot_api;
GRANT SELECT ON TABLE public.message_versions TO openedbot_worker;

-- acl: TABLE messages
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.messages TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.messages TO openedbot_worker;

-- acl: TABLE mobile_connect_tickets
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mobile_connect_tickets TO openedbot_api;

-- acl: TABLE native_auth_codes
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.native_auth_codes TO openedbot_api;

-- acl: TABLE oauth_attempts
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oauth_attempts TO openedbot_api;

-- acl: TABLE operator_profiles
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operator_profiles TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operator_profiles TO openedbot_worker;

-- acl: TABLE organization_agent_templates
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_agent_templates TO openedbot_api;

-- acl: TABLE organization_member_invitations
GRANT SELECT,INSERT,UPDATE ON TABLE public.organization_member_invitations TO openedbot_api;

-- acl: TABLE organization_permission_policies
GRANT SELECT ON TABLE public.organization_permission_policies TO openedbot_api;
GRANT SELECT ON TABLE public.organization_permission_policies TO openedbot_worker;

-- acl: TABLE organizations
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO openedbot_worker;

-- acl: TABLE playbooks
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.playbooks TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.playbooks TO openedbot_worker;

-- acl: TABLE product_features
GRANT SELECT,INSERT,UPDATE ON TABLE public.product_features TO openedbot_api;

-- acl: TABLE profile_delete_jobs
GRANT SELECT,INSERT,UPDATE ON TABLE public.profile_delete_jobs TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.profile_delete_jobs TO openedbot_worker;

-- acl: TABLE profile_import_items
GRANT SELECT,INSERT,UPDATE ON TABLE public.profile_import_items TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.profile_import_items TO openedbot_worker;

-- acl: TABLE profile_import_jobs
GRANT SELECT,INSERT,UPDATE ON TABLE public.profile_import_jobs TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.profile_import_jobs TO openedbot_worker;

-- acl: TABLE push_deliveries
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_deliveries TO openedbot_worker;

-- acl: TABLE push_outbox
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_outbox TO openedbot_worker;

-- acl: TABLE push_subscriptions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_subscriptions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_subscriptions TO openedbot_worker;

-- acl: TABLE routine_executions
GRANT SELECT,INSERT ON TABLE public.routine_executions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routine_executions TO openedbot_worker;

-- acl: TABLE routines
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routines TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.routines TO openedbot_worker;

-- acl: TABLE run_events
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.run_events TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.run_events TO openedbot_worker;

-- acl: SEQUENCE run_events_cursor_seq
GRANT SELECT,USAGE ON SEQUENCE public.run_events_cursor_seq TO openedbot_api;
GRANT SELECT,USAGE ON SEQUENCE public.run_events_cursor_seq TO openedbot_worker;

-- acl: TABLE run_steering_attempts
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.run_steering_attempts TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.run_steering_attempts TO openedbot_worker;

-- acl: TABLE runs
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runs TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runs TO openedbot_worker;

-- acl: TABLE runtime_a2a_audit
GRANT SELECT,INSERT ON TABLE public.runtime_a2a_audit TO openedbot_api;

-- acl: TABLE runtime_audit_anchors
GRANT SELECT,INSERT,UPDATE ON TABLE public.runtime_audit_anchors TO openedbot_api;

-- acl: TABLE runtime_audit_keys
GRANT SELECT,INSERT,UPDATE ON TABLE public.runtime_audit_keys TO openedbot_api;

-- acl: TABLE runtime_bot_settings_tools
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_bot_settings_tools TO openedbot_api;
GRANT SELECT ON TABLE public.runtime_bot_settings_tools TO openedbot_worker;

-- acl: TABLE runtime_connector_notices
GRANT INSERT ON TABLE public.runtime_connector_notices TO openedbot_api;
GRANT SELECT,UPDATE ON TABLE public.runtime_connector_notices TO openedbot_worker;

-- acl: TABLE runtime_connector_release_seen
GRANT SELECT,INSERT ON TABLE public.runtime_connector_release_seen TO openedbot_api;

-- acl: TABLE runtime_direct_exposures
GRANT SELECT,INSERT,UPDATE ON TABLE public.runtime_direct_exposures TO openedbot_api;
GRANT SELECT,UPDATE ON TABLE public.runtime_direct_exposures TO openedbot_worker;

-- acl: TABLE runtime_enrollments
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_enrollments TO openedbot_api;
GRANT SELECT,DELETE ON TABLE public.runtime_enrollments TO openedbot_worker;

-- acl: TABLE runtime_link_alerts
GRANT SELECT ON TABLE public.runtime_link_alerts TO openedbot_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.runtime_link_alerts TO openedbot_worker;

-- acl: TABLE runtime_link_diagnostics
GRANT SELECT,INSERT ON TABLE public.runtime_link_diagnostics TO openedbot_api;

-- acl: TABLE runtime_link_dispatches
GRANT SELECT,INSERT ON TABLE public.runtime_link_dispatches TO openedbot_api;

-- acl: SEQUENCE runtime_link_generation_seq
GRANT USAGE ON SEQUENCE public.runtime_link_generation_seq TO openedbot_api;

-- acl: TABLE runtime_model_proven
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_model_proven TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_model_proven TO openedbot_worker;

-- acl: TABLE runtime_model_selection_proofs
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_model_selection_proofs TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_model_selection_proofs TO openedbot_worker;

-- acl: TABLE runtime_permission_settings
GRANT SELECT,INSERT,UPDATE ON TABLE public.runtime_permission_settings TO openedbot_api;
GRANT SELECT ON TABLE public.runtime_permission_settings TO openedbot_worker;

-- acl: TABLE runtime_provider_incidents
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_provider_incidents TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_provider_incidents TO openedbot_worker;

-- acl: TABLE runtime_read_snapshots
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_read_snapshots TO openedbot_api;

-- acl: TABLE runtime_review_profiles
GRANT SELECT ON TABLE public.runtime_review_profiles TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_review_profiles TO openedbot_worker;

-- acl: TABLE runtime_routine_tools
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtime_routine_tools TO openedbot_api;
GRANT SELECT ON TABLE public.runtime_routine_tools TO openedbot_worker;

-- acl: TABLE runtimes
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtimes TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.runtimes TO openedbot_worker;

-- acl: TABLE sections
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sections TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sections TO openedbot_worker;

-- acl: TABLE service_instances
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.service_instances TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.service_instances TO openedbot_worker;

-- acl: TABLE sessions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO openedbot_api;

-- acl: TABLE staff_login_codes
GRANT SELECT,INSERT,UPDATE ON TABLE public.staff_login_codes TO openedbot_api;

-- acl: TABLE staff_sessions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_sessions TO openedbot_api;

-- acl: TABLE staff_users
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_users TO openedbot_api;

-- acl: TABLE stripe_events
GRANT SELECT,INSERT,UPDATE ON TABLE public.stripe_events TO openedbot_api;

-- acl: TABLE subscriptions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO openedbot_worker;

-- acl: TABLE support_attachments
GRANT SELECT,INSERT ON TABLE public.support_attachments TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_attachments TO openedbot_worker;

-- acl: TABLE support_conversations
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_conversations TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_conversations TO openedbot_worker;

-- acl: TABLE support_events
GRANT SELECT,INSERT ON TABLE public.support_events TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_events TO openedbot_worker;

-- acl: TABLE support_messages
GRANT SELECT,INSERT ON TABLE public.support_messages TO openedbot_api;

-- acl: TABLE team_imports
GRANT SELECT,INSERT ON TABLE public.team_imports TO openedbot_api;

-- acl: COLUMN team_imports.section_id
GRANT UPDATE(section_id) ON TABLE public.team_imports TO openedbot_api;

-- acl: TABLE tenant_blob_deletions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_blob_deletions TO openedbot_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_blob_deletions TO openedbot_api;

-- acl: TABLE tenant_deletions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_deletions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_deletions TO openedbot_worker;

-- acl: TABLE thread_compactions
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_compactions TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_compactions TO openedbot_worker;

-- acl: TABLE thread_hides
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_hides TO openedbot_api;

-- acl: TABLE thread_message_counters
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_message_counters TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_message_counters TO openedbot_worker;

-- acl: TABLE thread_reads
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.thread_reads TO openedbot_api;

-- acl: TABLE threads
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.threads TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.threads TO openedbot_worker;

-- acl: TABLE tool_errors
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tool_errors TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tool_errors TO openedbot_worker;

-- acl: TABLE user_workspace_preferences
GRANT SELECT,INSERT,UPDATE ON TABLE public.user_workspace_preferences TO openedbot_api;

-- acl: TABLE users
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO openedbot_api;
GRANT DELETE ON TABLE public.users TO openedbot_worker;

-- acl: COLUMN users.id
GRANT SELECT(id) ON TABLE public.users TO openedbot_worker;

-- acl: COLUMN users.email
GRANT SELECT(email) ON TABLE public.users TO openedbot_worker;

-- acl: TABLE webhook_deliveries
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_deliveries TO openedbot_api;

-- acl: TABLE webhook_endpoints
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webhook_endpoints TO openedbot_api;

-- acl: TABLE workflows
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workflows TO openedbot_api;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workflows TO openedbot_worker;

-- acl: TABLE workspace_activation
GRANT SELECT,INSERT,UPDATE ON TABLE public.workspace_activation TO openedbot_api;

--

INSERT INTO schema_migrations(version) VALUES ('0009_grants') ON CONFLICT DO NOTHING;

COMMIT;
