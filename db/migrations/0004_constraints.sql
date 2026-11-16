-- Baseline 4 of 10, generated from the schema of migrations 0001 to 0192.
-- Primary keys, unique and check constraints.

BEGIN;

-- constraint: account_deletions account_deletions_pkey
ALTER TABLE ONLY public.account_deletions
    ADD CONSTRAINT account_deletions_pkey PRIMARY KEY (user_id);

-- constraint: alert_channels alert_channels_organization_id_id_key
ALTER TABLE ONLY public.alert_channels
    ADD CONSTRAINT alert_channels_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: alert_channels alert_channels_organization_id_target_hash_key
ALTER TABLE ONLY public.alert_channels
    ADD CONSTRAINT alert_channels_organization_id_target_hash_key UNIQUE (organization_id, target_hash);

-- constraint: alert_channels alert_channels_pkey
ALTER TABLE ONLY public.alert_channels
    ADD CONSTRAINT alert_channels_pkey PRIMARY KEY (id);

-- constraint: alert_deliveries alert_deliveries_channel_id_alert_id_event_key
ALTER TABLE ONLY public.alert_deliveries
    ADD CONSTRAINT alert_deliveries_channel_id_alert_id_event_key UNIQUE (channel_id, alert_id, event);

-- constraint: alert_deliveries alert_deliveries_pkey
ALTER TABLE ONLY public.alert_deliveries
    ADD CONSTRAINT alert_deliveries_pkey PRIMARY KEY (id);

-- constraint: api_errors api_errors_pkey
ALTER TABLE ONLY public.api_errors
    ADD CONSTRAINT api_errors_pkey PRIMARY KEY (reference);

-- constraint: api_instances api_instances_pkey
ALTER TABLE ONLY public.api_instances
    ADD CONSTRAINT api_instances_pkey PRIMARY KEY (instance_id);

-- constraint: apns_deliveries apns_deliveries_organization_id_id_key
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: apns_deliveries apns_deliveries_outbox_id_device_id_key
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_outbox_id_device_id_key UNIQUE (outbox_id, device_id);

-- constraint: apns_deliveries apns_deliveries_pkey
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_pkey PRIMARY KEY (id);

-- constraint: apns_devices apns_devices_organization_id_id_key
ALTER TABLE ONLY public.apns_devices
    ADD CONSTRAINT apns_devices_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: apns_devices apns_devices_organization_id_user_id_installation_id_key
ALTER TABLE ONLY public.apns_devices
    ADD CONSTRAINT apns_devices_organization_id_user_id_installation_id_key UNIQUE (organization_id, user_id, installation_id);

-- constraint: apns_devices apns_devices_pkey
ALTER TABLE ONLY public.apns_devices
    ADD CONSTRAINT apns_devices_pkey PRIMARY KEY (id);

-- constraint: approval_requests approval_requests_organization_id_id_key
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: approval_requests approval_requests_pkey
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);

-- check constraint: approval_requests approval_requests_selected_choice_product_check
ALTER TABLE public.approval_requests
    ADD CONSTRAINT approval_requests_selected_choice_product_check CHECK (((selected_choice IS NULL) OR (selected_choice = ANY (ARRAY['once'::text, 'deny'::text])))) NOT VALID;

-- constraint: attachments attachments_object_key_key
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_object_key_key UNIQUE (object_key);

-- constraint: attachments attachments_organization_id_id_key
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: attachments attachments_pkey
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

-- constraint: audit_chain audit_chain_pkey
ALTER TABLE ONLY public.audit_chain
    ADD CONSTRAINT audit_chain_pkey PRIMARY KEY (runtime_id, seq);

-- constraint: audit_chain audit_chain_runtime_id_object_key_key
ALTER TABLE ONLY public.audit_chain
    ADD CONSTRAINT audit_chain_runtime_id_object_key_key UNIQUE (runtime_id, object_key);

-- constraint: audit_worm_orphans audit_worm_orphans_pkey
ALTER TABLE ONLY public.audit_worm_orphans
    ADD CONSTRAINT audit_worm_orphans_pkey PRIMARY KEY (id);

-- constraint: audit_worm_orphans audit_worm_orphans_runtime_id_object_key_anchor_id_key
ALTER TABLE ONLY public.audit_worm_orphans
    ADD CONSTRAINT audit_worm_orphans_runtime_id_object_key_anchor_id_key UNIQUE (runtime_id, object_key, anchor_id);

-- constraint: bot_groups bot_groups_organization_id_id_key
ALTER TABLE ONLY public.bot_groups
    ADD CONSTRAINT bot_groups_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: bot_groups bot_groups_pkey
ALTER TABLE ONLY public.bot_groups
    ADD CONSTRAINT bot_groups_pkey PRIMARY KEY (id);

-- constraint: bot_host_cleanups bot_host_cleanups_pkey
ALTER TABLE ONLY public.bot_host_cleanups
    ADD CONSTRAINT bot_host_cleanups_pkey PRIMARY KEY (id);

-- constraint: bot_permission_grants bot_permission_grants_organization_id_id_key
ALTER TABLE ONLY public.bot_permission_grants
    ADD CONSTRAINT bot_permission_grants_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: bot_permission_grants bot_permission_grants_pkey
ALTER TABLE ONLY public.bot_permission_grants
    ADD CONSTRAINT bot_permission_grants_pkey PRIMARY KEY (id);

-- constraint: bot_permission_rules bot_permission_rules_organization_id_id_key
ALTER TABLE ONLY public.bot_permission_rules
    ADD CONSTRAINT bot_permission_rules_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: bot_permission_rules bot_permission_rules_pkey
ALTER TABLE ONLY public.bot_permission_rules
    ADD CONSTRAINT bot_permission_rules_pkey PRIMARY KEY (id);

-- constraint: bot_permission_tool_policies bot_permission_tool_policies_pkey
ALTER TABLE ONLY public.bot_permission_tool_policies
    ADD CONSTRAINT bot_permission_tool_policies_pkey PRIMARY KEY (organization_id, bot_id, tool_key);

-- constraint: bot_playbooks bot_playbooks_pkey
ALTER TABLE ONLY public.bot_playbooks
    ADD CONSTRAINT bot_playbooks_pkey PRIMARY KEY (organization_id, bot_id, playbook_id);

-- constraint: bot_profile_provisions bot_profile_provisions_pkey
ALTER TABLE ONLY public.bot_profile_provisions
    ADD CONSTRAINT bot_profile_provisions_pkey PRIMARY KEY (bot_id);

-- constraint: bot_routine_tools bot_routine_tools_pkey
ALTER TABLE ONLY public.bot_routine_tools
    ADD CONSTRAINT bot_routine_tools_pkey PRIMARY KEY (organization_id, bot_id);

-- constraint: bot_setting_proposals bot_setting_proposals_organization_id_id_key
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: bot_setting_proposals bot_setting_proposals_pkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_pkey PRIMARY KEY (id);

-- constraint: bots bots_organization_id_hermes_profile_key
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_organization_id_hermes_profile_key UNIQUE (organization_id, hermes_profile);

-- constraint: bots bots_organization_id_id_key
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: bots bots_organization_id_slug_key
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_organization_id_slug_key UNIQUE (organization_id, slug);

-- constraint: bots bots_pkey
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_pkey PRIMARY KEY (id);

-- check constraint: decisions decisions_choice_product_check
ALTER TABLE public.decisions
    ADD CONSTRAINT decisions_choice_product_check CHECK ((choice = ANY (ARRAY['once'::text, 'deny'::text]))) NOT VALID;

-- constraint: decisions decisions_organization_id_id_key
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: decisions decisions_pkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);

-- constraint: email_login_codes email_login_codes_pkey
ALTER TABLE ONLY public.email_login_codes
    ADD CONSTRAINT email_login_codes_pkey PRIMARY KEY (id);

-- constraint: email_outbox email_outbox_dedupe_key_key
ALTER TABLE ONLY public.email_outbox
    ADD CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key);

-- constraint: email_outbox_events email_outbox_events_pkey
ALTER TABLE ONLY public.email_outbox_events
    ADD CONSTRAINT email_outbox_events_pkey PRIMARY KEY (id);

-- constraint: email_outbox email_outbox_pkey
ALTER TABLE ONLY public.email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);

-- constraint: execution_commands execution_commands_pkey
ALTER TABLE ONLY public.execution_commands
    ADD CONSTRAINT execution_commands_pkey PRIMARY KEY (id);

-- constraint: group_member_read_positions group_member_read_positions_pkey
ALTER TABLE ONLY public.group_member_read_positions
    ADD CONSTRAINT group_member_read_positions_pkey PRIMARY KEY (organization_id, group_id, bot_id);

-- constraint: group_members group_members_pkey
ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (organization_id, group_id, bot_id);

-- constraint: marketplace_entries marketplace_entries_pkey
ALTER TABLE ONLY public.marketplace_entries
    ADD CONSTRAINT marketplace_entries_pkey PRIMARY KEY (id);

-- constraint: marketplace_entries marketplace_entries_slug_key
ALTER TABLE ONLY public.marketplace_entries
    ADD CONSTRAINT marketplace_entries_slug_key UNIQUE (slug);

-- constraint: membership_events membership_events_pkey
ALTER TABLE ONLY public.membership_events
    ADD CONSTRAINT membership_events_pkey PRIMARY KEY (id);

-- constraint: memberships memberships_pkey
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (organization_id, user_id);

-- constraint: message_ingress message_ingress_organization_id_id_key
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: message_ingress message_ingress_organization_id_message_id_key
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_message_id_key UNIQUE (organization_id, message_id);

-- constraint: message_ingress message_ingress_organization_id_run_id_key
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_run_id_key UNIQUE (organization_id, run_id);

-- constraint: message_ingress message_ingress_organization_id_user_id_operation_idempoten_key
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_user_id_operation_idempoten_key UNIQUE (organization_id, user_id, operation, idempotency_key);

-- constraint: message_ingress message_ingress_organization_id_workflow_id_key
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_workflow_id_key UNIQUE (organization_id, workflow_id);

-- constraint: message_ingress message_ingress_pkey
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_pkey PRIMARY KEY (id);

-- constraint: message_reactions message_reactions_pkey
ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (organization_id, user_id, message_id, emoji);

-- constraint: message_versions message_versions_creator_idempotency_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_creator_idempotency_key UNIQUE (organization_id, created_by_user_id, idempotency_key);

-- constraint: message_versions message_versions_organization_id_branch_message_id_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_organization_id_branch_message_id_key UNIQUE (organization_id, branch_message_id);

-- constraint: message_versions message_versions_organization_id_branch_thread_id_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_organization_id_branch_thread_id_key UNIQUE (organization_id, branch_thread_id);

-- constraint: message_versions message_versions_organization_id_id_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: message_versions message_versions_organization_id_root_thread_id_root_messag_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_organization_id_root_thread_id_root_messag_key UNIQUE (organization_id, root_thread_id, root_message_id, ordinal);

-- constraint: message_versions message_versions_pkey
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_pkey PRIMARY KEY (id);

-- constraint: message_versions message_versions_run_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_run_key UNIQUE (organization_id, run_id);

-- constraint: message_versions message_versions_workflow_key
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_workflow_key UNIQUE (organization_id, workflow_id);

-- constraint: messages messages_organization_id_id_key
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: messages messages_pkey
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

-- constraint: mobile_connect_tickets mobile_connect_tickets_pkey
ALTER TABLE ONLY public.mobile_connect_tickets
    ADD CONSTRAINT mobile_connect_tickets_pkey PRIMARY KEY (id);

-- constraint: mobile_connect_tickets mobile_connect_tickets_secret_hash_key
ALTER TABLE ONLY public.mobile_connect_tickets
    ADD CONSTRAINT mobile_connect_tickets_secret_hash_key UNIQUE (secret_hash);

-- constraint: native_auth_codes native_auth_codes_code_hash_key
ALTER TABLE ONLY public.native_auth_codes
    ADD CONSTRAINT native_auth_codes_code_hash_key UNIQUE (code_hash);

-- constraint: native_auth_codes native_auth_codes_pkey
ALTER TABLE ONLY public.native_auth_codes
    ADD CONSTRAINT native_auth_codes_pkey PRIMARY KEY (id);

-- constraint: oauth_attempts oauth_attempts_pkey
ALTER TABLE ONLY public.oauth_attempts
    ADD CONSTRAINT oauth_attempts_pkey PRIMARY KEY (attempt_hash);

-- constraint: oauth_attempts oauth_attempts_state_hash_key
ALTER TABLE ONLY public.oauth_attempts
    ADD CONSTRAINT oauth_attempts_state_hash_key UNIQUE (state_hash);

-- constraint: operator_profiles operator_profiles_organization_id_username_key
ALTER TABLE ONLY public.operator_profiles
    ADD CONSTRAINT operator_profiles_organization_id_username_key UNIQUE (organization_id, username);

-- constraint: operator_profiles operator_profiles_pkey
ALTER TABLE ONLY public.operator_profiles
    ADD CONSTRAINT operator_profiles_pkey PRIMARY KEY (organization_id);

-- constraint: organization_agent_templates organization_agent_templates_organization_id_id_key
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: organization_agent_templates organization_agent_templates_organization_id_slug_key
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_organization_id_slug_key UNIQUE (organization_id, slug);

-- constraint: organization_agent_templates organization_agent_templates_pkey
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_pkey PRIMARY KEY (id);

-- constraint: organization_member_invitations organization_member_invitations_pkey
ALTER TABLE ONLY public.organization_member_invitations
    ADD CONSTRAINT organization_member_invitations_pkey PRIMARY KEY (id);

-- constraint: organization_member_invitations organization_member_invitations_token_hash_key
ALTER TABLE ONLY public.organization_member_invitations
    ADD CONSTRAINT organization_member_invitations_token_hash_key UNIQUE (token_hash);

-- constraint: organization_permission_policies organization_permission_policies_pkey
ALTER TABLE ONLY public.organization_permission_policies
    ADD CONSTRAINT organization_permission_policies_pkey PRIMARY KEY (organization_id);

-- constraint: organizations organizations_personal_owner_unique
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_personal_owner_unique UNIQUE (personal_owner_user_id);

-- constraint: organizations organizations_pkey
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

-- constraint: organizations organizations_slug_key
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

-- constraint: playbooks playbooks_organization_id_id_key
ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: playbooks playbooks_organization_id_key_key
ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_organization_id_key_key UNIQUE (organization_id, key);

-- constraint: playbooks playbooks_pkey
ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);

-- constraint: product_features product_features_pkey
ALTER TABLE ONLY public.product_features
    ADD CONSTRAINT product_features_pkey PRIMARY KEY (feature_key);

-- constraint: profile_delete_jobs profile_delete_jobs_organization_id_id_key
ALTER TABLE ONLY public.profile_delete_jobs
    ADD CONSTRAINT profile_delete_jobs_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: profile_delete_jobs profile_delete_jobs_pkey
ALTER TABLE ONLY public.profile_delete_jobs
    ADD CONSTRAINT profile_delete_jobs_pkey PRIMARY KEY (id);

-- constraint: profile_import_items profile_import_items_job_id_slug_key
ALTER TABLE ONLY public.profile_import_items
    ADD CONSTRAINT profile_import_items_job_id_slug_key UNIQUE (job_id, slug);

-- constraint: profile_import_items profile_import_items_pkey
ALTER TABLE ONLY public.profile_import_items
    ADD CONSTRAINT profile_import_items_pkey PRIMARY KEY (job_id, ordinal);

-- constraint: profile_import_jobs profile_import_jobs_organization_id_id_key
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: profile_import_jobs profile_import_jobs_organization_id_idempotency_key_key
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_organization_id_idempotency_key_key UNIQUE (organization_id, idempotency_key);

-- constraint: profile_import_jobs profile_import_jobs_pkey
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_pkey PRIMARY KEY (id);

-- constraint: push_deliveries push_deliveries_organization_id_id_key
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: push_deliveries push_deliveries_pkey
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_pkey PRIMARY KEY (id);

-- constraint: push_deliveries push_deliveries_workflow_id_notification_sequence_subscript_key
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_workflow_id_notification_sequence_subscript_key UNIQUE (workflow_id, notification_sequence, subscription_id);

-- constraint: push_outbox push_outbox_organization_id_id_key
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: push_outbox push_outbox_organization_id_workflow_id_notification_sequen_key
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_organization_id_workflow_id_notification_sequen_key UNIQUE (organization_id, workflow_id, notification_sequence);

-- constraint: push_outbox push_outbox_pkey
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_pkey PRIMARY KEY (id);

-- constraint: push_subscriptions push_subscriptions_endpoint_key
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

-- constraint: push_subscriptions push_subscriptions_organization_id_id_key
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: push_subscriptions push_subscriptions_pkey
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

-- constraint: routine_executions routine_executions_organization_id_id_key
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: routine_executions routine_executions_pkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_pkey PRIMARY KEY (id);

-- constraint: routines routines_organization_id_id_key
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: routines routines_pkey
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_pkey PRIMARY KEY (id);

-- constraint: run_events run_events_organization_id_run_id_sequence_key
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_organization_id_run_id_sequence_key UNIQUE (organization_id, run_id, sequence);

-- constraint: run_events run_events_pkey
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (cursor);

-- constraint: run_steering_attempts run_steering_attempts_organization_id_id_key
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: run_steering_attempts run_steering_attempts_organization_id_source_run_id_key
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_source_run_id_key UNIQUE (organization_id, source_run_id);

-- constraint: run_steering_attempts run_steering_attempts_pkey
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_pkey PRIMARY KEY (id);

-- constraint: runs runs_organization_id_id_key
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: runs runs_pkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

-- constraint: runtime_a2a_audit runtime_a2a_audit_pkey
ALTER TABLE ONLY public.runtime_a2a_audit
    ADD CONSTRAINT runtime_a2a_audit_pkey PRIMARY KEY (organization_id, runtime_id, source, source_offset);

-- constraint: runtime_audit_anchors runtime_audit_anchors_pkey
ALTER TABLE ONLY public.runtime_audit_anchors
    ADD CONSTRAINT runtime_audit_anchors_pkey PRIMARY KEY (runtime_id);

-- constraint: runtime_audit_keys runtime_audit_keys_pkey
ALTER TABLE ONLY public.runtime_audit_keys
    ADD CONSTRAINT runtime_audit_keys_pkey PRIMARY KEY (id);

-- constraint: runtime_audit_keys runtime_audit_keys_runtime_id_key_id_key
ALTER TABLE ONLY public.runtime_audit_keys
    ADD CONSTRAINT runtime_audit_keys_runtime_id_key_id_key UNIQUE (runtime_id, key_id);

-- constraint: runtime_audit_verifications runtime_audit_verifications_pkey
ALTER TABLE ONLY public.runtime_audit_verifications
    ADD CONSTRAINT runtime_audit_verifications_pkey PRIMARY KEY (id);

-- constraint: runtime_audit_verifications runtime_audit_verifications_runtime_id_export_sha256_key
ALTER TABLE ONLY public.runtime_audit_verifications
    ADD CONSTRAINT runtime_audit_verifications_runtime_id_export_sha256_key UNIQUE (runtime_id, export_sha256);

-- constraint: runtime_bot_settings_tools runtime_bot_settings_tools_pkey
ALTER TABLE ONLY public.runtime_bot_settings_tools
    ADD CONSTRAINT runtime_bot_settings_tools_pkey PRIMARY KEY (organization_id, runtime_id);

-- constraint: runtime_connector_notices runtime_connector_notices_pkey
ALTER TABLE ONLY public.runtime_connector_notices
    ADD CONSTRAINT runtime_connector_notices_pkey PRIMARY KEY (id);

-- constraint: runtime_connector_notices runtime_connector_notices_runtime_id_installed_version_targ_key
ALTER TABLE ONLY public.runtime_connector_notices
    ADD CONSTRAINT runtime_connector_notices_runtime_id_installed_version_targ_key UNIQUE (runtime_id, installed_version, target_version);

-- constraint: runtime_connector_release_seen runtime_connector_release_seen_pkey
ALTER TABLE ONLY public.runtime_connector_release_seen
    ADD CONSTRAINT runtime_connector_release_seen_pkey PRIMARY KEY (organization_id, user_id, version);

-- constraint: runtime_direct_exposures runtime_direct_exposures_organization_id_id_key
ALTER TABLE ONLY public.runtime_direct_exposures
    ADD CONSTRAINT runtime_direct_exposures_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: runtime_direct_exposures runtime_direct_exposures_pkey
ALTER TABLE ONLY public.runtime_direct_exposures
    ADD CONSTRAINT runtime_direct_exposures_pkey PRIMARY KEY (id);

-- constraint: runtime_enrollments runtime_enrollments_pkey
ALTER TABLE ONLY public.runtime_enrollments
    ADD CONSTRAINT runtime_enrollments_pkey PRIMARY KEY (id);

-- constraint: runtime_enrollments runtime_enrollments_secret_hash_key
ALTER TABLE ONLY public.runtime_enrollments
    ADD CONSTRAINT runtime_enrollments_secret_hash_key UNIQUE (secret_hash);

-- constraint: runtime_link_alerts runtime_link_alerts_pkey
ALTER TABLE ONLY public.runtime_link_alerts
    ADD CONSTRAINT runtime_link_alerts_pkey PRIMARY KEY (id);

-- constraint: runtime_link_diagnostics runtime_link_diagnostics_pkey
ALTER TABLE ONLY public.runtime_link_diagnostics
    ADD CONSTRAINT runtime_link_diagnostics_pkey PRIMARY KEY (id);

-- constraint: runtime_link_diagnostics runtime_link_diagnostics_runtime_id_event_id_key
ALTER TABLE ONLY public.runtime_link_diagnostics
    ADD CONSTRAINT runtime_link_diagnostics_runtime_id_event_id_key UNIQUE (runtime_id, event_id);

-- constraint: runtime_link_dispatches runtime_link_dispatches_pkey
ALTER TABLE ONLY public.runtime_link_dispatches
    ADD CONSTRAINT runtime_link_dispatches_pkey PRIMARY KEY (id);

-- constraint: runtime_link_events runtime_link_events_pkey
ALTER TABLE ONLY public.runtime_link_events
    ADD CONSTRAINT runtime_link_events_pkey PRIMARY KEY (id);

-- constraint: runtime_model_proven runtime_model_proven_pkey
ALTER TABLE ONLY public.runtime_model_proven
    ADD CONSTRAINT runtime_model_proven_pkey PRIMARY KEY (runtime_id, provider, model);

-- constraint: runtime_model_selection_proofs runtime_model_selection_proofs_pkey
ALTER TABLE ONLY public.runtime_model_selection_proofs
    ADD CONSTRAINT runtime_model_selection_proofs_pkey PRIMARY KEY (runtime_id);

-- constraint: runtime_permission_settings runtime_permission_settings_pkey
ALTER TABLE ONLY public.runtime_permission_settings
    ADD CONSTRAINT runtime_permission_settings_pkey PRIMARY KEY (runtime_id);

-- constraint: runtime_provider_incidents runtime_provider_incidents_organization_id_id_key
ALTER TABLE ONLY public.runtime_provider_incidents
    ADD CONSTRAINT runtime_provider_incidents_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: runtime_provider_incidents runtime_provider_incidents_organization_id_runtime_id_provi_key
ALTER TABLE ONLY public.runtime_provider_incidents
    ADD CONSTRAINT runtime_provider_incidents_organization_id_runtime_id_provi_key UNIQUE (organization_id, runtime_id, provider);

-- constraint: runtime_provider_incidents runtime_provider_incidents_pkey
ALTER TABLE ONLY public.runtime_provider_incidents
    ADD CONSTRAINT runtime_provider_incidents_pkey PRIMARY KEY (id);

-- constraint: runtime_read_snapshots runtime_read_snapshots_pkey
ALTER TABLE ONLY public.runtime_read_snapshots
    ADD CONSTRAINT runtime_read_snapshots_pkey PRIMARY KEY (organization_id, runtime_id, kind);

-- constraint: runtime_review_profiles runtime_review_profiles_pkey
ALTER TABLE ONLY public.runtime_review_profiles
    ADD CONSTRAINT runtime_review_profiles_pkey PRIMARY KEY (runtime_id);

-- constraint: runtime_routine_tools runtime_routine_tools_pkey
ALTER TABLE ONLY public.runtime_routine_tools
    ADD CONSTRAINT runtime_routine_tools_pkey PRIMARY KEY (organization_id, runtime_id);

-- constraint: runtimes runtimes_link_token_hash_key
ALTER TABLE ONLY public.runtimes
    ADD CONSTRAINT runtimes_link_token_hash_key UNIQUE (link_token_hash);

-- constraint: runtimes runtimes_link_token_previous_hash_key
ALTER TABLE ONLY public.runtimes
    ADD CONSTRAINT runtimes_link_token_previous_hash_key UNIQUE (link_token_previous_hash);

-- constraint: runtimes runtimes_organization_id_id_key
ALTER TABLE ONLY public.runtimes
    ADD CONSTRAINT runtimes_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: runtimes runtimes_pkey
ALTER TABLE ONLY public.runtimes
    ADD CONSTRAINT runtimes_pkey PRIMARY KEY (id);

-- constraint: sections sections_organization_id_id_key
ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: sections sections_organization_id_position_key
ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_organization_id_position_key UNIQUE (organization_id, "position");

-- constraint: sections sections_pkey
ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (id);

-- constraint: service_instances service_instances_pkey
ALTER TABLE ONLY public.service_instances
    ADD CONSTRAINT service_instances_pkey PRIMARY KEY (id);

-- constraint: sessions sessions_access_token_hash_key
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_access_token_hash_key UNIQUE (access_token_hash);

-- constraint: sessions sessions_pkey
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

-- constraint: sessions sessions_refresh_token_hash_key
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);

-- constraint: sessions sessions_session_token_hash_key
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_session_token_hash_key UNIQUE (session_token_hash);

-- constraint: staff_impersonation_claims staff_impersonation_claims_claim_token_hash_key
ALTER TABLE ONLY public.staff_impersonation_claims
    ADD CONSTRAINT staff_impersonation_claims_claim_token_hash_key UNIQUE (claim_token_hash);

-- constraint: staff_impersonation_claims staff_impersonation_claims_pkey
ALTER TABLE ONLY public.staff_impersonation_claims
    ADD CONSTRAINT staff_impersonation_claims_pkey PRIMARY KEY (id);

-- constraint: staff_login_codes staff_login_codes_pkey
ALTER TABLE ONLY public.staff_login_codes
    ADD CONSTRAINT staff_login_codes_pkey PRIMARY KEY (id);

-- constraint: staff_sessions staff_sessions_pkey
ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT staff_sessions_pkey PRIMARY KEY (id);

-- constraint: staff_sessions staff_sessions_session_token_hash_key
ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT staff_sessions_session_token_hash_key UNIQUE (session_token_hash);

-- constraint: staff_users staff_users_pkey
ALTER TABLE ONLY public.staff_users
    ADD CONSTRAINT staff_users_pkey PRIMARY KEY (id);

-- constraint: stripe_events stripe_events_pkey
ALTER TABLE ONLY public.stripe_events
    ADD CONSTRAINT stripe_events_pkey PRIMARY KEY (id);

-- constraint: subscriptions subscriptions_pkey
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (organization_id);

-- constraint: subscriptions subscriptions_stripe_customer_id_key
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_customer_id_key UNIQUE (stripe_customer_id);

-- constraint: subscriptions subscriptions_stripe_subscription_id_key
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);

-- constraint: support_attachments support_attachments_object_key_key
ALTER TABLE ONLY public.support_attachments
    ADD CONSTRAINT support_attachments_object_key_key UNIQUE (object_key);

-- constraint: support_attachments support_attachments_pkey
ALTER TABLE ONLY public.support_attachments
    ADD CONSTRAINT support_attachments_pkey PRIMARY KEY (id);

-- constraint: support_conversations support_conversations_guest_token_hash_key
ALTER TABLE ONLY public.support_conversations
    ADD CONSTRAINT support_conversations_guest_token_hash_key UNIQUE (guest_token_hash);

-- constraint: support_conversations support_conversations_pkey
ALTER TABLE ONLY public.support_conversations
    ADD CONSTRAINT support_conversations_pkey PRIMARY KEY (id);

-- constraint: support_events support_events_pkey
ALTER TABLE ONLY public.support_events
    ADD CONSTRAINT support_events_pkey PRIMARY KEY (cursor);

-- constraint: support_messages support_messages_pkey
ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);

-- constraint: team_imports team_imports_organization_id_id_key
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: team_imports team_imports_organization_id_source_id_source_release_key
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_organization_id_source_id_source_release_key UNIQUE (organization_id, source_id, source_release);

-- constraint: team_imports team_imports_pkey
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_pkey PRIMARY KEY (id);

-- constraint: tenant_blob_deletions tenant_blob_deletions_pkey
ALTER TABLE ONLY public.tenant_blob_deletions
    ADD CONSTRAINT tenant_blob_deletions_pkey PRIMARY KEY (object_key);

-- check constraint: tenant_deletions tenant_deletions_attempts_nonnegative
ALTER TABLE public.tenant_deletions
    ADD CONSTRAINT tenant_deletions_attempts_nonnegative CHECK ((attempts >= 0)) NOT VALID;

-- constraint: tenant_deletions tenant_deletions_pkey
ALTER TABLE ONLY public.tenant_deletions
    ADD CONSTRAINT tenant_deletions_pkey PRIMARY KEY (organization_id);

-- constraint: thread_compactions thread_compactions_pkey
ALTER TABLE ONLY public.thread_compactions
    ADD CONSTRAINT thread_compactions_pkey PRIMARY KEY (organization_id, thread_id);

-- constraint: thread_hides thread_hides_pkey
ALTER TABLE ONLY public.thread_hides
    ADD CONSTRAINT thread_hides_pkey PRIMARY KEY (organization_id, user_id, thread_id);

-- constraint: thread_message_counters thread_message_counters_pkey
ALTER TABLE ONLY public.thread_message_counters
    ADD CONSTRAINT thread_message_counters_pkey PRIMARY KEY (organization_id, thread_id);

-- constraint: thread_reads thread_reads_pkey
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_pkey PRIMARY KEY (organization_id, user_id, thread_id);

-- constraint: threads threads_organization_id_group_id_key
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_group_id_key UNIQUE (organization_id, group_id);

-- constraint: threads threads_organization_id_hermes_session_id_key
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_hermes_session_id_key UNIQUE (organization_id, hermes_session_id);

-- constraint: threads threads_organization_id_id_key
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: threads threads_pkey
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);

-- constraint: tool_errors tool_errors_organization_id_id_key
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: tool_errors tool_errors_pkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_pkey PRIMARY KEY (id);

-- constraint: user_workspace_preferences user_workspace_preferences_pkey
ALTER TABLE ONLY public.user_workspace_preferences
    ADD CONSTRAINT user_workspace_preferences_pkey PRIMARY KEY (organization_id, user_id);

-- constraint: users users_google_subject_key
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_google_subject_key UNIQUE (google_subject);

-- constraint: users users_pkey
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- constraint: webhook_deliveries webhook_deliveries_organization_id_endpoint_id_idempotency__key
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_endpoint_id_idempotency__key UNIQUE (organization_id, endpoint_id, idempotency_key);

-- constraint: webhook_deliveries webhook_deliveries_organization_id_id_key
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: webhook_deliveries webhook_deliveries_pkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

-- constraint: webhook_endpoints webhook_endpoints_organization_id_id_key
ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: webhook_endpoints webhook_endpoints_pkey
ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

-- constraint: webhook_management_operations webhook_management_operations_organization_id_user_id_opera_key
ALTER TABLE ONLY public.webhook_management_operations
    ADD CONSTRAINT webhook_management_operations_organization_id_user_id_opera_key UNIQUE (organization_id, user_id, operation, idempotency_key);

-- constraint: webhook_management_operations webhook_management_operations_pkey
ALTER TABLE ONLY public.webhook_management_operations
    ADD CONSTRAINT webhook_management_operations_pkey PRIMARY KEY (id);

-- constraint: workflows workflows_organization_id_id_key
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_id_key UNIQUE (organization_id, id);

-- constraint: workflows workflows_organization_id_root_run_id_key
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_root_run_id_key UNIQUE (organization_id, root_run_id);

-- constraint: workflows workflows_pkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);

-- constraint: workspace_activation workspace_activation_pkey
ALTER TABLE ONLY public.workspace_activation
    ADD CONSTRAINT workspace_activation_pkey PRIMARY KEY (organization_id);

INSERT INTO schema_migrations(version) VALUES ('0004_constraints') ON CONFLICT DO NOTHING;

COMMIT;
