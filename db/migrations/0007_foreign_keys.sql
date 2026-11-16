-- Baseline 7 of 10, generated from the schema of migrations 0001 to 0192.
-- Foreign keys. Created after the indexes, as pg_dump orders them.

BEGIN;

-- fk constraint: account_deletions account_deletions_user_id_fkey
ALTER TABLE ONLY public.account_deletions
    ADD CONSTRAINT account_deletions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;

-- fk constraint: alert_channels alert_channels_created_by_fkey
ALTER TABLE ONLY public.alert_channels
    ADD CONSTRAINT alert_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: alert_channels alert_channels_organization_id_fkey
ALTER TABLE ONLY public.alert_channels
    ADD CONSTRAINT alert_channels_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: alert_deliveries alert_deliveries_alert_id_fkey
ALTER TABLE ONLY public.alert_deliveries
    ADD CONSTRAINT alert_deliveries_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.runtime_link_alerts(id) ON DELETE CASCADE;

-- fk constraint: alert_deliveries alert_deliveries_organization_id_channel_id_fkey
ALTER TABLE ONLY public.alert_deliveries
    ADD CONSTRAINT alert_deliveries_organization_id_channel_id_fkey FOREIGN KEY (organization_id, channel_id) REFERENCES public.alert_channels(organization_id, id) ON DELETE CASCADE;

-- fk constraint: alert_deliveries alert_deliveries_organization_id_fkey
ALTER TABLE ONLY public.alert_deliveries
    ADD CONSTRAINT alert_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: api_errors api_errors_organization_id_fkey
ALTER TABLE ONLY public.api_errors
    ADD CONSTRAINT api_errors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: api_errors api_errors_user_id_fkey
ALTER TABLE ONLY public.api_errors
    ADD CONSTRAINT api_errors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: apns_deliveries apns_deliveries_organization_id_device_id_fkey
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_organization_id_device_id_fkey FOREIGN KEY (organization_id, device_id) REFERENCES public.apns_devices(organization_id, id) ON DELETE CASCADE;

-- fk constraint: apns_deliveries apns_deliveries_organization_id_fkey
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: apns_deliveries apns_deliveries_organization_id_outbox_id_fkey
ALTER TABLE ONLY public.apns_deliveries
    ADD CONSTRAINT apns_deliveries_organization_id_outbox_id_fkey FOREIGN KEY (organization_id, outbox_id) REFERENCES public.push_outbox(organization_id, id) ON DELETE CASCADE;

-- fk constraint: apns_devices apns_devices_organization_id_fkey
ALTER TABLE ONLY public.apns_devices
    ADD CONSTRAINT apns_devices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: apns_devices apns_devices_organization_id_user_id_fkey
ALTER TABLE ONLY public.apns_devices
    ADD CONSTRAINT apns_devices_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: approval_requests approval_requests_organization_id_fkey
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: approval_requests approval_requests_organization_id_run_id_fkey
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: approval_requests approval_requests_organization_id_thread_id_fkey
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: approval_requests approval_requests_resolved_by_membership_fkey
ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_resolved_by_membership_fkey FOREIGN KEY (organization_id, resolved_by) REFERENCES public.memberships(organization_id, user_id);

-- fk constraint: attachments attachments_organization_id_fkey
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: attachments attachments_organization_id_message_id_fkey
ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_organization_id_message_id_fkey FOREIGN KEY (organization_id, message_id) REFERENCES public.messages(organization_id, id) ON DELETE CASCADE;

-- fk constraint: audit_chain audit_chain_organization_id_fkey
ALTER TABLE ONLY public.audit_chain
    ADD CONSTRAINT audit_chain_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: audit_worm_orphans audit_worm_orphans_organization_id_fkey
ALTER TABLE ONLY public.audit_worm_orphans
    ADD CONSTRAINT audit_worm_orphans_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_groups bot_groups_organization_id_fkey
ALTER TABLE ONLY public.bot_groups
    ADD CONSTRAINT bot_groups_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_groups bot_groups_organization_id_section_id_fkey
ALTER TABLE ONLY public.bot_groups
    ADD CONSTRAINT bot_groups_organization_id_section_id_fkey FOREIGN KEY (organization_id, section_id) REFERENCES public.sections(organization_id, id);

-- fk constraint: bot_host_cleanups bot_host_cleanups_organization_id_fkey
ALTER TABLE ONLY public.bot_host_cleanups
    ADD CONSTRAINT bot_host_cleanups_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_host_cleanups bot_host_cleanups_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.bot_host_cleanups
    ADD CONSTRAINT bot_host_cleanups_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id);

-- fk constraint: bot_permission_grants bot_permission_grants_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_permission_grants
    ADD CONSTRAINT bot_permission_grants_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_permission_grants bot_permission_grants_organization_id_created_from_approva_fkey
ALTER TABLE ONLY public.bot_permission_grants
    ADD CONSTRAINT bot_permission_grants_organization_id_created_from_approva_fkey FOREIGN KEY (organization_id, created_from_approval_id) REFERENCES public.approval_requests(organization_id, id) ON DELETE SET NULL (created_from_approval_id);

-- fk constraint: bot_permission_grants bot_permission_grants_organization_id_fkey
ALTER TABLE ONLY public.bot_permission_grants
    ADD CONSTRAINT bot_permission_grants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_permission_rules bot_permission_rules_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_permission_rules
    ADD CONSTRAINT bot_permission_rules_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_permission_rules bot_permission_rules_organization_id_fkey
ALTER TABLE ONLY public.bot_permission_rules
    ADD CONSTRAINT bot_permission_rules_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_permission_tool_policies bot_permission_tool_policies_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_permission_tool_policies
    ADD CONSTRAINT bot_permission_tool_policies_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_permission_tool_policies bot_permission_tool_policies_organization_id_fkey
ALTER TABLE ONLY public.bot_permission_tool_policies
    ADD CONSTRAINT bot_permission_tool_policies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_permission_tool_policies bot_permission_tool_policies_updated_by_user_id_fkey
ALTER TABLE ONLY public.bot_permission_tool_policies
    ADD CONSTRAINT bot_permission_tool_policies_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: bot_playbooks bot_playbooks_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_playbooks
    ADD CONSTRAINT bot_playbooks_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_playbooks bot_playbooks_organization_id_playbook_id_fkey
ALTER TABLE ONLY public.bot_playbooks
    ADD CONSTRAINT bot_playbooks_organization_id_playbook_id_fkey FOREIGN KEY (organization_id, playbook_id) REFERENCES public.playbooks(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_profile_provisions bot_profile_provisions_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_profile_provisions
    ADD CONSTRAINT bot_profile_provisions_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_profile_provisions bot_profile_provisions_organization_id_fkey
ALTER TABLE ONLY public.bot_profile_provisions
    ADD CONSTRAINT bot_profile_provisions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_profile_provisions bot_profile_provisions_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.bot_profile_provisions
    ADD CONSTRAINT bot_profile_provisions_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id);

-- fk constraint: bot_routine_tools bot_routine_tools_decided_by_membership_fkey
ALTER TABLE ONLY public.bot_routine_tools
    ADD CONSTRAINT bot_routine_tools_decided_by_membership_fkey FOREIGN KEY (organization_id, decided_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (decided_by_user_id);

-- fk constraint: bot_routine_tools bot_routine_tools_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_routine_tools
    ADD CONSTRAINT bot_routine_tools_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_setting_proposals bot_setting_proposals_organization_id_bot_id_fkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_setting_proposals bot_setting_proposals_organization_id_fkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bot_setting_proposals bot_setting_proposals_organization_id_run_id_fkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_setting_proposals bot_setting_proposals_organization_id_thread_id_fkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: bot_setting_proposals bot_setting_proposals_resolved_by_membership_fkey
ALTER TABLE ONLY public.bot_setting_proposals
    ADD CONSTRAINT bot_setting_proposals_resolved_by_membership_fkey FOREIGN KEY (organization_id, resolved_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (resolved_by);

-- fk constraint: bots bots_organization_id_fkey
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: bots bots_organization_id_section_id_fkey
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_organization_id_section_id_fkey FOREIGN KEY (organization_id, section_id) REFERENCES public.sections(organization_id, id);

-- fk constraint: decisions decisions_actor_membership_fkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_actor_membership_fkey FOREIGN KEY (organization_id, actor_user_id) REFERENCES public.memberships(organization_id, user_id);

-- fk constraint: decisions decisions_organization_id_approval_request_id_fkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_organization_id_approval_request_id_fkey FOREIGN KEY (organization_id, approval_request_id) REFERENCES public.approval_requests(organization_id, id) ON DELETE SET NULL (approval_request_id);

-- fk constraint: decisions decisions_organization_id_fkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: decisions decisions_organization_id_run_id_fkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE SET NULL (run_id);

-- fk constraint: decisions decisions_organization_id_thread_id_fkey
ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE SET NULL (thread_id);

-- fk constraint: execution_commands execution_commands_organization_id_fkey
ALTER TABLE ONLY public.execution_commands
    ADD CONSTRAINT execution_commands_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: execution_commands execution_commands_organization_id_thread_id_fkey
ALTER TABLE ONLY public.execution_commands
    ADD CONSTRAINT execution_commands_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: execution_commands execution_commands_requested_by_user_id_fkey
ALTER TABLE ONLY public.execution_commands
    ADD CONSTRAINT execution_commands_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: group_member_read_positions group_member_read_positions_organization_id_fkey
ALTER TABLE ONLY public.group_member_read_positions
    ADD CONSTRAINT group_member_read_positions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: group_member_read_positions group_member_read_positions_organization_id_group_id_bot_i_fkey
ALTER TABLE ONLY public.group_member_read_positions
    ADD CONSTRAINT group_member_read_positions_organization_id_group_id_bot_i_fkey FOREIGN KEY (organization_id, group_id, bot_id) REFERENCES public.group_members(organization_id, group_id, bot_id) ON DELETE CASCADE;

-- fk constraint: group_members group_members_organization_id_bot_id_fkey
ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: group_members group_members_organization_id_fkey
ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: group_members group_members_organization_id_group_id_fkey
ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_organization_id_group_id_fkey FOREIGN KEY (organization_id, group_id) REFERENCES public.bot_groups(organization_id, id) ON DELETE CASCADE;

-- fk constraint: marketplace_entries marketplace_entries_created_by_staff_fkey
ALTER TABLE ONLY public.marketplace_entries
    ADD CONSTRAINT marketplace_entries_created_by_staff_fkey FOREIGN KEY (created_by_staff) REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- fk constraint: membership_events membership_events_organization_id_fkey
ALTER TABLE ONLY public.membership_events
    ADD CONSTRAINT membership_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: memberships memberships_organization_id_fkey
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: memberships memberships_user_id_fkey
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- fk constraint: message_ingress message_ingress_organization_id_fkey
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: message_ingress message_ingress_organization_id_thread_id_fkey
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: message_ingress message_ingress_user_fkey
ALTER TABLE ONLY public.message_ingress
    ADD CONSTRAINT message_ingress_user_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- fk constraint: message_reactions message_reactions_organization_id_fkey
ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: message_reactions message_reactions_organization_id_thread_id_message_id_fkey
ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_organization_id_thread_id_message_id_fkey FOREIGN KEY (organization_id, thread_id, message_id) REFERENCES public.messages(organization_id, thread_id, id) ON DELETE CASCADE;

-- fk constraint: message_reactions message_reactions_organization_id_user_id_fkey
ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_branch_message_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_branch_message_fk FOREIGN KEY (organization_id, branch_thread_id, branch_message_id) REFERENCES public.messages(organization_id, thread_id, id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_branch_thread_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_branch_thread_fk FOREIGN KEY (organization_id, branch_thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_creator_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_creator_fk FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (created_by_user_id);

-- fk constraint: message_versions message_versions_organization_id_fkey
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_parent_message_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_parent_message_fk FOREIGN KEY (organization_id, parent_thread_id, parent_message_id) REFERENCES public.messages(organization_id, thread_id, id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_root_message_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_root_message_fk FOREIGN KEY (organization_id, root_thread_id, root_message_id) REFERENCES public.messages(organization_id, thread_id, id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_run_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_run_fk FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: message_versions message_versions_workflow_fk
ALTER TABLE ONLY public.message_versions
    ADD CONSTRAINT message_versions_workflow_fk FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE CASCADE;

-- fk constraint: messages messages_organization_id_author_bot_id_fkey
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_organization_id_author_bot_id_fkey FOREIGN KEY (organization_id, author_bot_id) REFERENCES public.bots(organization_id, id) ON DELETE SET NULL (author_bot_id);

-- fk constraint: messages messages_organization_id_fkey
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: messages messages_organization_id_run_id_fkey
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id);

-- fk constraint: messages messages_organization_id_thread_id_fkey
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: messages messages_reply_same_thread_fk
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_same_thread_fk FOREIGN KEY (organization_id, thread_id, reply_to_id) REFERENCES public.messages(organization_id, thread_id, id) ON DELETE RESTRICT;

-- fk constraint: mobile_connect_tickets mobile_connect_tickets_organization_id_fkey
ALTER TABLE ONLY public.mobile_connect_tickets
    ADD CONSTRAINT mobile_connect_tickets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: mobile_connect_tickets mobile_connect_tickets_user_id_fkey
ALTER TABLE ONLY public.mobile_connect_tickets
    ADD CONSTRAINT mobile_connect_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- fk constraint: native_auth_codes native_auth_codes_organization_id_user_id_fkey
ALTER TABLE ONLY public.native_auth_codes
    ADD CONSTRAINT native_auth_codes_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: native_auth_codes native_auth_codes_user_fk
ALTER TABLE ONLY public.native_auth_codes
    ADD CONSTRAINT native_auth_codes_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- fk constraint: operator_profiles operator_profiles_organization_id_fkey
ALTER TABLE ONLY public.operator_profiles
    ADD CONSTRAINT operator_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: organization_agent_templates organization_agent_templates_created_by_membership_fkey
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_created_by_membership_fkey FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (created_by_user_id);

-- fk constraint: organization_agent_templates organization_agent_templates_organization_id_fkey
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: organization_agent_templates organization_agent_templates_source_bot_fkey
ALTER TABLE ONLY public.organization_agent_templates
    ADD CONSTRAINT organization_agent_templates_source_bot_fkey FOREIGN KEY (organization_id, source_bot_id) REFERENCES public.bots(organization_id, id) ON DELETE SET NULL (source_bot_id);

-- fk constraint: organization_member_invitations organization_member_invitations_accepted_user_id_fkey
ALTER TABLE ONLY public.organization_member_invitations
    ADD CONSTRAINT organization_member_invitations_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: organization_member_invitations organization_member_invitations_invited_by_user_id_fkey
ALTER TABLE ONLY public.organization_member_invitations
    ADD CONSTRAINT organization_member_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: organization_member_invitations organization_member_invitations_organization_id_fkey
ALTER TABLE ONLY public.organization_member_invitations
    ADD CONSTRAINT organization_member_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: organization_permission_policies organization_permission_policies_organization_id_fkey
ALTER TABLE ONLY public.organization_permission_policies
    ADD CONSTRAINT organization_permission_policies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: organization_permission_policies organization_permission_policies_updated_by_user_id_fkey
ALTER TABLE ONLY public.organization_permission_policies
    ADD CONSTRAINT organization_permission_policies_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: organizations organizations_personal_owner_user_id_fkey
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_personal_owner_user_id_fkey FOREIGN KEY (personal_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: playbooks playbooks_organization_id_fkey
ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: profile_delete_jobs profile_delete_jobs_created_by_user_id_fkey
ALTER TABLE ONLY public.profile_delete_jobs
    ADD CONSTRAINT profile_delete_jobs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: profile_delete_jobs profile_delete_jobs_organization_id_fkey
ALTER TABLE ONLY public.profile_delete_jobs
    ADD CONSTRAINT profile_delete_jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: profile_delete_jobs profile_delete_jobs_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.profile_delete_jobs
    ADD CONSTRAINT profile_delete_jobs_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id);

-- fk constraint: profile_import_items profile_import_items_organization_id_job_id_fkey
ALTER TABLE ONLY public.profile_import_items
    ADD CONSTRAINT profile_import_items_organization_id_job_id_fkey FOREIGN KEY (organization_id, job_id) REFERENCES public.profile_import_jobs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: profile_import_jobs profile_import_jobs_acknowledged_by_fkey
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: profile_import_jobs profile_import_jobs_created_by_user_id_fkey
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: profile_import_jobs profile_import_jobs_organization_id_fkey
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: profile_import_jobs profile_import_jobs_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.profile_import_jobs
    ADD CONSTRAINT profile_import_jobs_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id);

-- fk constraint: push_deliveries push_deliveries_organization_id_fkey
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: push_deliveries push_deliveries_organization_id_workflow_id_fkey
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_organization_id_workflow_id_fkey FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE CASCADE;

-- fk constraint: push_deliveries push_deliveries_subscription_id_fkey
ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.push_subscriptions(id) ON DELETE CASCADE;

-- fk constraint: push_outbox push_outbox_organization_id_fkey
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: push_outbox push_outbox_organization_id_workflow_id_fkey
ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_organization_id_workflow_id_fkey FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE CASCADE;

-- fk constraint: push_subscriptions push_subscriptions_organization_id_fkey
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: push_subscriptions push_subscriptions_organization_id_user_id_fkey
ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: routine_executions routine_executions_organization_id_fkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: routine_executions routine_executions_organization_id_routine_id_fkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_routine_id_fkey FOREIGN KEY (organization_id, routine_id) REFERENCES public.routines(organization_id, id) ON DELETE CASCADE;

-- fk constraint: routine_executions routine_executions_organization_id_run_id_fkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE SET NULL (run_id);

-- fk constraint: routine_executions routine_executions_organization_id_thread_id_fkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE SET NULL (thread_id);

-- fk constraint: routine_executions routine_executions_organization_id_workflow_id_fkey
ALTER TABLE ONLY public.routine_executions
    ADD CONSTRAINT routine_executions_organization_id_workflow_id_fkey FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE SET NULL (workflow_id);

-- fk constraint: routines routines_created_by_user_fkey
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_created_by_user_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: routines routines_group_fk
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES public.bot_groups(organization_id, id) ON DELETE CASCADE;

-- fk constraint: routines routines_organization_id_bot_id_fkey
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: routines routines_organization_id_fkey
ALTER TABLE ONLY public.routines
    ADD CONSTRAINT routines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: run_events run_events_organization_id_fkey
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: run_events run_events_organization_id_run_id_fkey
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: run_events run_events_organization_id_thread_id_fkey
ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: run_steering_attempts run_steering_attempts_organization_id_fkey
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: run_steering_attempts run_steering_attempts_organization_id_source_run_id_fkey
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_source_run_id_fkey FOREIGN KEY (organization_id, source_run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: run_steering_attempts run_steering_attempts_organization_id_target_run_id_fkey
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_target_run_id_fkey FOREIGN KEY (organization_id, target_run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: run_steering_attempts run_steering_attempts_organization_id_thread_id_fkey
ALTER TABLE ONLY public.run_steering_attempts
    ADD CONSTRAINT run_steering_attempts_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runs runs_caller_bot_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_caller_bot_fkey FOREIGN KEY (organization_id, caller_bot_id) REFERENCES public.bots(organization_id, id) ON DELETE SET NULL (caller_bot_id);

-- fk constraint: runs runs_caller_run_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_caller_run_fkey FOREIGN KEY (organization_id, caller_run_id) REFERENCES public.runs(organization_id, id) ON DELETE SET NULL (caller_run_id);

-- fk constraint: runs runs_initiator_user_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_initiator_user_fkey FOREIGN KEY (initiator_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: runs runs_organization_id_bot_id_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE SET NULL (bot_id);

-- fk constraint: runs runs_organization_id_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runs runs_organization_id_thread_id_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runs runs_resumes_run_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_resumes_run_fkey FOREIGN KEY (organization_id, resumes_run_id) REFERENCES public.runs(organization_id, id) ON DELETE SET NULL (resumes_run_id);

-- fk constraint: runs runs_source_message_fk
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_source_message_fk FOREIGN KEY (organization_id, source_message_id) REFERENCES public.messages(organization_id, id) ON DELETE SET NULL (source_message_id);

-- fk constraint: runs runs_workflow_fkey
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_workflow_fkey FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE SET NULL (workflow_id);

-- fk constraint: runtime_a2a_audit runtime_a2a_audit_organization_id_fkey
ALTER TABLE ONLY public.runtime_a2a_audit
    ADD CONSTRAINT runtime_a2a_audit_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_a2a_audit runtime_a2a_audit_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_a2a_audit
    ADD CONSTRAINT runtime_a2a_audit_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_anchors runtime_audit_anchors_organization_id_fkey
ALTER TABLE ONLY public.runtime_audit_anchors
    ADD CONSTRAINT runtime_audit_anchors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_anchors runtime_audit_anchors_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_audit_anchors
    ADD CONSTRAINT runtime_audit_anchors_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_keys runtime_audit_keys_organization_id_fkey
ALTER TABLE ONLY public.runtime_audit_keys
    ADD CONSTRAINT runtime_audit_keys_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_keys runtime_audit_keys_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_audit_keys
    ADD CONSTRAINT runtime_audit_keys_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_verifications runtime_audit_verifications_organization_id_fkey
ALTER TABLE ONLY public.runtime_audit_verifications
    ADD CONSTRAINT runtime_audit_verifications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_verifications runtime_audit_verifications_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_audit_verifications
    ADD CONSTRAINT runtime_audit_verifications_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_audit_verifications runtime_audit_verifications_verified_by_fkey
ALTER TABLE ONLY public.runtime_audit_verifications
    ADD CONSTRAINT runtime_audit_verifications_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: runtime_bot_settings_tools runtime_bot_settings_tools_created_by_membership_fkey
ALTER TABLE ONLY public.runtime_bot_settings_tools
    ADD CONSTRAINT runtime_bot_settings_tools_created_by_membership_fkey FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (created_by_user_id);

-- fk constraint: runtime_bot_settings_tools runtime_bot_settings_tools_organization_id_fkey
ALTER TABLE ONLY public.runtime_bot_settings_tools
    ADD CONSTRAINT runtime_bot_settings_tools_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_bot_settings_tools runtime_bot_settings_tools_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_bot_settings_tools
    ADD CONSTRAINT runtime_bot_settings_tools_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_connector_notices runtime_connector_notices_organization_id_fkey
ALTER TABLE ONLY public.runtime_connector_notices
    ADD CONSTRAINT runtime_connector_notices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_connector_notices runtime_connector_notices_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_connector_notices
    ADD CONSTRAINT runtime_connector_notices_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_connector_release_seen runtime_connector_release_seen_organization_id_fkey
ALTER TABLE ONLY public.runtime_connector_release_seen
    ADD CONSTRAINT runtime_connector_release_seen_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_connector_release_seen runtime_connector_release_seen_organization_id_user_id_fkey
ALTER TABLE ONLY public.runtime_connector_release_seen
    ADD CONSTRAINT runtime_connector_release_seen_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: runtime_direct_exposures runtime_direct_exposures_created_by_user_id_fkey
ALTER TABLE ONLY public.runtime_direct_exposures
    ADD CONSTRAINT runtime_direct_exposures_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: runtime_direct_exposures runtime_direct_exposures_organization_id_fkey
ALTER TABLE ONLY public.runtime_direct_exposures
    ADD CONSTRAINT runtime_direct_exposures_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_direct_exposures runtime_direct_exposures_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_direct_exposures
    ADD CONSTRAINT runtime_direct_exposures_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id);

-- fk constraint: runtime_enrollments runtime_enrollments_claimed_by_fkey
ALTER TABLE ONLY public.runtime_enrollments
    ADD CONSTRAINT runtime_enrollments_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: runtime_enrollments runtime_enrollments_organization_id_fkey
ALTER TABLE ONLY public.runtime_enrollments
    ADD CONSTRAINT runtime_enrollments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_link_alerts runtime_link_alerts_acknowledged_by_fkey
ALTER TABLE ONLY public.runtime_link_alerts
    ADD CONSTRAINT runtime_link_alerts_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- fk constraint: runtime_link_alerts runtime_link_alerts_concerned_user_id_fkey
ALTER TABLE ONLY public.runtime_link_alerts
    ADD CONSTRAINT runtime_link_alerts_concerned_user_id_fkey FOREIGN KEY (concerned_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: runtime_link_alerts runtime_link_alerts_organization_id_fkey
ALTER TABLE ONLY public.runtime_link_alerts
    ADD CONSTRAINT runtime_link_alerts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_link_diagnostics runtime_link_diagnostics_organization_id_fkey
ALTER TABLE ONLY public.runtime_link_diagnostics
    ADD CONSTRAINT runtime_link_diagnostics_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_link_diagnostics runtime_link_diagnostics_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_link_diagnostics
    ADD CONSTRAINT runtime_link_diagnostics_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_link_dispatches runtime_link_dispatches_organization_id_fkey
ALTER TABLE ONLY public.runtime_link_dispatches
    ADD CONSTRAINT runtime_link_dispatches_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_link_dispatches runtime_link_dispatches_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_link_dispatches
    ADD CONSTRAINT runtime_link_dispatches_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_link_events runtime_link_events_organization_id_fkey
ALTER TABLE ONLY public.runtime_link_events
    ADD CONSTRAINT runtime_link_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_model_proven runtime_model_proven_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_model_proven
    ADD CONSTRAINT runtime_model_proven_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_model_selection_proofs runtime_model_selection_proofs_organization_id_fkey
ALTER TABLE ONLY public.runtime_model_selection_proofs
    ADD CONSTRAINT runtime_model_selection_proofs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_model_selection_proofs runtime_model_selection_proofs_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_model_selection_proofs
    ADD CONSTRAINT runtime_model_selection_proofs_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_permission_settings runtime_permission_settings_organization_id_fkey
ALTER TABLE ONLY public.runtime_permission_settings
    ADD CONSTRAINT runtime_permission_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_permission_settings runtime_permission_settings_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_permission_settings
    ADD CONSTRAINT runtime_permission_settings_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_provider_incidents runtime_provider_incidents_organization_id_fkey
ALTER TABLE ONLY public.runtime_provider_incidents
    ADD CONSTRAINT runtime_provider_incidents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_provider_incidents runtime_provider_incidents_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_provider_incidents
    ADD CONSTRAINT runtime_provider_incidents_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_read_snapshots runtime_read_snapshots_organization_id_fkey
ALTER TABLE ONLY public.runtime_read_snapshots
    ADD CONSTRAINT runtime_read_snapshots_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_read_snapshots runtime_read_snapshots_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_read_snapshots
    ADD CONSTRAINT runtime_read_snapshots_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_review_profiles runtime_review_profiles_organization_id_fkey
ALTER TABLE ONLY public.runtime_review_profiles
    ADD CONSTRAINT runtime_review_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_review_profiles runtime_review_profiles_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_review_profiles
    ADD CONSTRAINT runtime_review_profiles_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtime_routine_tools runtime_routine_tools_created_by_membership_fkey
ALTER TABLE ONLY public.runtime_routine_tools
    ADD CONSTRAINT runtime_routine_tools_created_by_membership_fkey FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (created_by_user_id);

-- fk constraint: runtime_routine_tools runtime_routine_tools_organization_id_fkey
ALTER TABLE ONLY public.runtime_routine_tools
    ADD CONSTRAINT runtime_routine_tools_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: runtime_routine_tools runtime_routine_tools_organization_id_runtime_id_fkey
ALTER TABLE ONLY public.runtime_routine_tools
    ADD CONSTRAINT runtime_routine_tools_organization_id_runtime_id_fkey FOREIGN KEY (organization_id, runtime_id) REFERENCES public.runtimes(organization_id, id) ON DELETE CASCADE;

-- fk constraint: runtimes runtimes_organization_id_fkey
ALTER TABLE ONLY public.runtimes
    ADD CONSTRAINT runtimes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: sections sections_organization_id_fkey
ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: sessions sessions_impersonated_by_staff_user_id_fkey
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_impersonated_by_staff_user_id_fkey FOREIGN KEY (impersonated_by_staff_user_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;

-- fk constraint: sessions sessions_initial_organization_fk
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_initial_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

-- fk constraint: sessions sessions_user_fk
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- fk constraint: staff_impersonation_claims staff_impersonation_claims_session_id_fkey
ALTER TABLE ONLY public.staff_impersonation_claims
    ADD CONSTRAINT staff_impersonation_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

-- fk constraint: staff_impersonation_claims staff_impersonation_claims_staff_user_id_fkey
ALTER TABLE ONLY public.staff_impersonation_claims
    ADD CONSTRAINT staff_impersonation_claims_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;

-- fk constraint: staff_login_codes staff_login_codes_staff_user_id_fkey
ALTER TABLE ONLY public.staff_login_codes
    ADD CONSTRAINT staff_login_codes_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.staff_users(id) ON DELETE CASCADE;

-- fk constraint: staff_sessions staff_sessions_staff_user_id_fkey
ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT staff_sessions_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.staff_users(id) ON DELETE CASCADE;

-- fk constraint: subscriptions subscriptions_organization_id_fkey
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: support_attachments support_attachments_conversation_id_fkey
ALTER TABLE ONLY public.support_attachments
    ADD CONSTRAINT support_attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(id) ON DELETE CASCADE;

-- fk constraint: support_attachments support_attachments_message_id_fkey
ALTER TABLE ONLY public.support_attachments
    ADD CONSTRAINT support_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.support_messages(id) ON DELETE CASCADE;

-- fk constraint: support_conversations support_conversations_assigned_staff_user_id_fkey
ALTER TABLE ONLY public.support_conversations
    ADD CONSTRAINT support_conversations_assigned_staff_user_id_fkey FOREIGN KEY (assigned_staff_user_id) REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- fk constraint: support_conversations support_conversations_user_id_fkey
ALTER TABLE ONLY public.support_conversations
    ADD CONSTRAINT support_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: support_events support_events_conversation_id_fkey
ALTER TABLE ONLY public.support_events
    ADD CONSTRAINT support_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(id) ON DELETE CASCADE;

-- fk constraint: support_messages support_messages_conversation_id_fkey
ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(id) ON DELETE CASCADE;

-- fk constraint: support_messages support_messages_staff_user_id_fkey
ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- fk constraint: team_imports team_imports_organization_id_created_by_user_id_fkey
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_organization_id_created_by_user_id_fkey FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL;

-- fk constraint: team_imports team_imports_organization_id_fkey
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: team_imports team_imports_organization_id_section_id_fkey
ALTER TABLE ONLY public.team_imports
    ADD CONSTRAINT team_imports_organization_id_section_id_fkey FOREIGN KEY (organization_id, section_id) REFERENCES public.sections(organization_id, id);

-- fk constraint: tenant_deletions tenant_deletions_organization_id_fkey
ALTER TABLE ONLY public.tenant_deletions
    ADD CONSTRAINT tenant_deletions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: thread_compactions thread_compactions_organization_id_fkey
ALTER TABLE ONLY public.thread_compactions
    ADD CONSTRAINT thread_compactions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: thread_compactions thread_compactions_organization_id_thread_id_fkey
ALTER TABLE ONLY public.thread_compactions
    ADD CONSTRAINT thread_compactions_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: thread_hides thread_hides_organization_id_fkey
ALTER TABLE ONLY public.thread_hides
    ADD CONSTRAINT thread_hides_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: thread_hides thread_hides_organization_id_thread_id_fkey
ALTER TABLE ONLY public.thread_hides
    ADD CONSTRAINT thread_hides_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: thread_hides thread_hides_organization_id_user_id_fkey
ALTER TABLE ONLY public.thread_hides
    ADD CONSTRAINT thread_hides_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: thread_message_counters thread_message_counters_organization_id_fkey
ALTER TABLE ONLY public.thread_message_counters
    ADD CONSTRAINT thread_message_counters_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: thread_message_counters thread_message_counters_organization_id_thread_id_fkey
ALTER TABLE ONLY public.thread_message_counters
    ADD CONSTRAINT thread_message_counters_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: thread_reads thread_reads_organization_id_fkey
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: thread_reads thread_reads_organization_id_thread_id_fkey
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: thread_reads thread_reads_organization_id_user_id_fkey
ALTER TABLE ONLY public.thread_reads
    ADD CONSTRAINT thread_reads_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: threads threads_organization_id_bot_id_fkey
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: threads threads_organization_id_fkey
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: threads threads_organization_id_group_id_fkey
ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_organization_id_group_id_fkey FOREIGN KEY (organization_id, group_id) REFERENCES public.bot_groups(organization_id, id) ON DELETE CASCADE;

-- fk constraint: tool_errors tool_errors_organization_id_bot_id_fkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_bot_id_fkey FOREIGN KEY (organization_id, bot_id) REFERENCES public.bots(organization_id, id) ON DELETE CASCADE;

-- fk constraint: tool_errors tool_errors_organization_id_fkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: tool_errors tool_errors_organization_id_run_id_fkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE CASCADE;

-- fk constraint: tool_errors tool_errors_organization_id_thread_id_fkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: tool_errors tool_errors_organization_id_user_id_fkey
ALTER TABLE ONLY public.tool_errors
    ADD CONSTRAINT tool_errors_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (user_id);

-- fk constraint: user_workspace_preferences user_workspace_preferences_organization_id_user_id_fkey
ALTER TABLE ONLY public.user_workspace_preferences
    ADD CONSTRAINT user_workspace_preferences_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_endpoint_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_endpoint_id_fkey FOREIGN KEY (organization_id, endpoint_id) REFERENCES public.webhook_endpoints(organization_id, id) ON DELETE RESTRICT;

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_message_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_message_id_fkey FOREIGN KEY (organization_id, message_id) REFERENCES public.messages(organization_id, id) ON DELETE SET NULL (message_id);

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_run_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_run_id_fkey FOREIGN KEY (organization_id, run_id) REFERENCES public.runs(organization_id, id) ON DELETE SET NULL (run_id);

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_thread_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: webhook_deliveries webhook_deliveries_organization_id_workflow_id_fkey
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_organization_id_workflow_id_fkey FOREIGN KEY (organization_id, workflow_id) REFERENCES public.workflows(organization_id, id) ON DELETE SET NULL (workflow_id);

-- fk constraint: webhook_endpoints webhook_endpoints_organization_id_created_by_user_id_fkey
ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_organization_id_created_by_user_id_fkey FOREIGN KEY (organization_id, created_by_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE SET NULL (created_by_user_id);

-- fk constraint: webhook_endpoints webhook_endpoints_organization_id_fkey
ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: webhook_endpoints webhook_endpoints_organization_id_thread_id_fkey
ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: webhook_management_operations webhook_management_operations_organization_id_endpoint_id_fkey
ALTER TABLE ONLY public.webhook_management_operations
    ADD CONSTRAINT webhook_management_operations_organization_id_endpoint_id_fkey FOREIGN KEY (organization_id, endpoint_id) REFERENCES public.webhook_endpoints(organization_id, id) ON DELETE CASCADE;

-- fk constraint: webhook_management_operations webhook_management_operations_organization_id_fkey
ALTER TABLE ONLY public.webhook_management_operations
    ADD CONSTRAINT webhook_management_operations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: webhook_management_operations webhook_management_operations_organization_id_user_id_fkey
ALTER TABLE ONLY public.webhook_management_operations
    ADD CONSTRAINT webhook_management_operations_organization_id_user_id_fkey FOREIGN KEY (organization_id, user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE;

-- fk constraint: workflows workflows_initiator_user_fkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_initiator_user_fkey FOREIGN KEY (initiator_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- fk constraint: workflows workflows_organization_id_fkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- fk constraint: workflows workflows_organization_id_root_bot_id_fkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_root_bot_id_fkey FOREIGN KEY (organization_id, root_bot_id) REFERENCES public.bots(organization_id, id) ON DELETE SET NULL (root_bot_id);

-- fk constraint: workflows workflows_organization_id_thread_id_fkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_organization_id_thread_id_fkey FOREIGN KEY (organization_id, thread_id) REFERENCES public.threads(organization_id, id) ON DELETE CASCADE;

-- fk constraint: workflows workflows_root_run_fkey
ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_root_run_fkey FOREIGN KEY (organization_id, root_run_id) REFERENCES public.runs(organization_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- fk constraint: workspace_activation workspace_activation_organization_id_fkey
ALTER TABLE ONLY public.workspace_activation
    ADD CONSTRAINT workspace_activation_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

INSERT INTO schema_migrations(version) VALUES ('0007_foreign_keys') ON CONFLICT DO NOTHING;

COMMIT;
