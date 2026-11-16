-- Baseline 8 of 10, generated from the schema of migrations 0001 to 0192.
-- Row level security: ENABLE/FORCE per table, then its policies.

BEGIN;

-- row security: account_deletions
ALTER TABLE public.account_deletions ENABLE ROW LEVEL SECURITY;

-- policy: account_deletions account_deletions_owner
CREATE POLICY account_deletions_owner ON public.account_deletions TO openedbot_api USING ((user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)) WITH CHECK ((user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid));

-- policy: account_deletions account_deletions_worker
CREATE POLICY account_deletions_worker ON public.account_deletions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: alert_channels
ALTER TABLE public.alert_channels ENABLE ROW LEVEL SECURITY;

-- policy: alert_channels alert_channels_tenant
CREATE POLICY alert_channels_tenant ON public.alert_channels TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: alert_channels alert_channels_worker
CREATE POLICY alert_channels_worker ON public.alert_channels TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: alert_deliveries
ALTER TABLE public.alert_deliveries ENABLE ROW LEVEL SECURITY;

-- policy: alert_deliveries alert_deliveries_worker
CREATE POLICY alert_deliveries_worker ON public.alert_deliveries TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: api_errors
ALTER TABLE public.api_errors ENABLE ROW LEVEL SECURITY;

-- policy: api_errors api_errors_api_insert
CREATE POLICY api_errors_api_insert ON public.api_errors FOR INSERT TO openedbot_api WITH CHECK (((organization_id IS NULL) OR (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)));

-- policy: api_errors api_errors_worker_expired
CREATE POLICY api_errors_worker_expired ON public.api_errors FOR SELECT TO openedbot_worker USING ((occurred_at < (now() - '90 days'::interval)));

-- policy: api_errors api_errors_worker_purge
CREATE POLICY api_errors_worker_purge ON public.api_errors FOR DELETE TO openedbot_worker USING ((occurred_at < (now() - '90 days'::interval)));

-- row security: apns_deliveries
ALTER TABLE public.apns_deliveries ENABLE ROW LEVEL SECURITY;

-- policy: apns_deliveries apns_deliveries_worker
CREATE POLICY apns_deliveries_worker ON public.apns_deliveries TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: apns_devices
ALTER TABLE public.apns_devices ENABLE ROW LEVEL SECURITY;

-- policy: apns_devices apns_devices_owner
CREATE POLICY apns_devices_owner ON public.apns_devices TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)));

-- policy: apns_devices apns_devices_worker
CREATE POLICY apns_devices_worker ON public.apns_devices TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: approval_requests
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

-- policy: approval_requests approval_requests_tenant
CREATE POLICY approval_requests_tenant ON public.approval_requests TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: approval_requests approval_requests_worker
CREATE POLICY approval_requests_worker ON public.approval_requests TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: attachments
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

-- policy: attachments attachments_tenant
CREATE POLICY attachments_tenant ON public.attachments TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: attachments attachments_worker
CREATE POLICY attachments_worker ON public.attachments TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: audit_chain
ALTER TABLE public.audit_chain ENABLE ROW LEVEL SECURITY;

-- policy: audit_chain audit_chain_api
CREATE POLICY audit_chain_api ON public.audit_chain TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = audit_chain.runtime_id) AND (r.organization_id = audit_chain.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now())))))))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = audit_chain.runtime_id) AND (r.organization_id = audit_chain.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now()))))))));

-- row security: audit_worm_orphans
ALTER TABLE public.audit_worm_orphans ENABLE ROW LEVEL SECURITY;

-- policy: audit_worm_orphans audit_worm_orphans_api
CREATE POLICY audit_worm_orphans_api ON public.audit_worm_orphans TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = audit_worm_orphans.runtime_id) AND (r.organization_id = audit_worm_orphans.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now())))))))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = audit_worm_orphans.runtime_id) AND (r.organization_id = audit_worm_orphans.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now()))))))));

-- row security: bot_groups
ALTER TABLE public.bot_groups ENABLE ROW LEVEL SECURITY;

-- policy: bot_groups bot_groups_tenant
CREATE POLICY bot_groups_tenant ON public.bot_groups TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_groups bot_groups_worker
CREATE POLICY bot_groups_worker ON public.bot_groups TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: bot_host_cleanups
ALTER TABLE public.bot_host_cleanups ENABLE ROW LEVEL SECURITY;

-- policy: bot_host_cleanups bot_host_cleanups_tenant
CREATE POLICY bot_host_cleanups_tenant ON public.bot_host_cleanups TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_host_cleanups bot_host_cleanups_worker
CREATE POLICY bot_host_cleanups_worker ON public.bot_host_cleanups TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: bot_permission_grants
ALTER TABLE public.bot_permission_grants ENABLE ROW LEVEL SECURITY;

-- policy: bot_permission_grants bot_permission_grants_tenant
CREATE POLICY bot_permission_grants_tenant ON public.bot_permission_grants TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_permission_grants bot_permission_grants_worker
CREATE POLICY bot_permission_grants_worker ON public.bot_permission_grants FOR SELECT TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: bot_permission_rules
ALTER TABLE public.bot_permission_rules ENABLE ROW LEVEL SECURITY;

-- policy: bot_permission_rules bot_permission_rules_tenant
CREATE POLICY bot_permission_rules_tenant ON public.bot_permission_rules TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_permission_rules bot_permission_rules_worker
CREATE POLICY bot_permission_rules_worker ON public.bot_permission_rules FOR SELECT TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: bot_permission_tool_policies
ALTER TABLE public.bot_permission_tool_policies ENABLE ROW LEVEL SECURITY;

-- policy: bot_permission_tool_policies bot_permission_tool_policies_tenant
CREATE POLICY bot_permission_tool_policies_tenant ON public.bot_permission_tool_policies TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_permission_tool_policies bot_permission_tool_policies_worker
CREATE POLICY bot_permission_tool_policies_worker ON public.bot_permission_tool_policies FOR SELECT TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: bot_playbooks
ALTER TABLE public.bot_playbooks ENABLE ROW LEVEL SECURITY;

-- policy: bot_playbooks bot_playbooks_tenant
CREATE POLICY bot_playbooks_tenant ON public.bot_playbooks TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_playbooks bot_playbooks_worker
CREATE POLICY bot_playbooks_worker ON public.bot_playbooks TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: bot_profile_provisions
ALTER TABLE public.bot_profile_provisions ENABLE ROW LEVEL SECURITY;

-- policy: bot_profile_provisions bot_profile_provisions_tenant
CREATE POLICY bot_profile_provisions_tenant ON public.bot_profile_provisions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_profile_provisions bot_profile_provisions_worker
CREATE POLICY bot_profile_provisions_worker ON public.bot_profile_provisions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: bot_routine_tools
ALTER TABLE public.bot_routine_tools ENABLE ROW LEVEL SECURITY;

-- policy: bot_routine_tools bot_routine_tools_tenant
CREATE POLICY bot_routine_tools_tenant ON public.bot_routine_tools TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bot_routine_tools bot_routine_tools_worker
CREATE POLICY bot_routine_tools_worker ON public.bot_routine_tools FOR SELECT TO openedbot_worker USING (true);

-- row security: bot_setting_proposals
ALTER TABLE public.bot_setting_proposals ENABLE ROW LEVEL SECURITY;

-- policy: bot_setting_proposals bot_setting_proposals_tenant
CREATE POLICY bot_setting_proposals_tenant ON public.bot_setting_proposals TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: bots
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;

-- policy: bots bots_tenant
CREATE POLICY bots_tenant ON public.bots TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: bots bots_worker
CREATE POLICY bots_worker ON public.bots TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: decisions
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;

-- policy: decisions decisions_tenant
CREATE POLICY decisions_tenant ON public.decisions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: email_login_codes
ALTER TABLE public.email_login_codes ENABLE ROW LEVEL SECURITY;

-- policy: email_login_codes email_login_codes_api
CREATE POLICY email_login_codes_api ON public.email_login_codes TO openedbot_api USING ((email = NULLIF(current_setting('app.login_email'::text, true), ''::text))) WITH CHECK ((email = NULLIF(current_setting('app.login_email'::text, true), ''::text)));

-- row security: email_outbox
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;

-- policy: email_outbox email_outbox_api
CREATE POLICY email_outbox_api ON public.email_outbox FOR INSERT TO openedbot_api WITH CHECK (true);

-- policy: email_outbox email_outbox_worker
CREATE POLICY email_outbox_worker ON public.email_outbox TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: execution_commands
ALTER TABLE public.execution_commands ENABLE ROW LEVEL SECURITY;

-- policy: execution_commands execution_commands_tenant
CREATE POLICY execution_commands_tenant ON public.execution_commands TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: execution_commands execution_commands_worker
CREATE POLICY execution_commands_worker ON public.execution_commands TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: group_member_read_positions
ALTER TABLE public.group_member_read_positions ENABLE ROW LEVEL SECURITY;

-- policy: group_member_read_positions group_member_read_positions_tenant
CREATE POLICY group_member_read_positions_tenant ON public.group_member_read_positions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: group_member_read_positions group_member_read_positions_worker
CREATE POLICY group_member_read_positions_worker ON public.group_member_read_positions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: group_members
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

-- policy: group_members group_members_tenant
CREATE POLICY group_members_tenant ON public.group_members TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: group_members group_members_worker
CREATE POLICY group_members_worker ON public.group_members TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: membership_events
ALTER TABLE public.membership_events ENABLE ROW LEVEL SECURITY;

-- policy: membership_events membership_events_tenant
CREATE POLICY membership_events_tenant ON public.membership_events TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: memberships
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- policy: memberships memberships_tenant
CREATE POLICY memberships_tenant ON public.memberships TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid))) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: memberships memberships_worker
CREATE POLICY memberships_worker ON public.memberships TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: message_ingress
ALTER TABLE public.message_ingress ENABLE ROW LEVEL SECURITY;

-- policy: message_ingress message_ingress_tenant
CREATE POLICY message_ingress_tenant ON public.message_ingress TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: message_ingress message_ingress_worker
CREATE POLICY message_ingress_worker ON public.message_ingress TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: message_reactions
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

-- policy: message_reactions message_reactions_tenant
CREATE POLICY message_reactions_tenant ON public.message_reactions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: message_versions
ALTER TABLE public.message_versions ENABLE ROW LEVEL SECURITY;

-- policy: message_versions message_versions_tenant
CREATE POLICY message_versions_tenant ON public.message_versions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: message_versions message_versions_worker
CREATE POLICY message_versions_worker ON public.message_versions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: messages
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- policy: messages messages_tenant
CREATE POLICY messages_tenant ON public.messages TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: messages messages_worker
CREATE POLICY messages_worker ON public.messages TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: mobile_connect_tickets
ALTER TABLE public.mobile_connect_tickets ENABLE ROW LEVEL SECURITY;

-- policy: mobile_connect_tickets mobile_connect_tickets_credential
CREATE POLICY mobile_connect_tickets_credential ON public.mobile_connect_tickets TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (secret_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (secret_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text))));

-- row security: native_auth_codes
ALTER TABLE public.native_auth_codes ENABLE ROW LEVEL SECURITY;

-- policy: native_auth_codes native_auth_codes_credential
CREATE POLICY native_auth_codes_credential ON public.native_auth_codes TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (code_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (code_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text))));

-- row security: oauth_attempts
ALTER TABLE public.oauth_attempts ENABLE ROW LEVEL SECURITY;

-- policy: oauth_attempts oauth_attempts_delete_lookup
CREATE POLICY oauth_attempts_delete_lookup ON public.oauth_attempts FOR DELETE TO openedbot_api USING (((attempt_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)) OR (state_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text))));

-- policy: oauth_attempts oauth_attempts_insert_lookup
CREATE POLICY oauth_attempts_insert_lookup ON public.oauth_attempts FOR INSERT TO openedbot_api WITH CHECK (((attempt_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)) OR (state_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text))));

-- policy: oauth_attempts oauth_attempts_select_lookup
CREATE POLICY oauth_attempts_select_lookup ON public.oauth_attempts FOR SELECT TO openedbot_api USING (((attempt_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)) OR (state_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text))));

-- policy: oauth_attempts oauth_attempts_update_lookup
CREATE POLICY oauth_attempts_update_lookup ON public.oauth_attempts FOR UPDATE TO openedbot_api USING (((attempt_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)) OR (state_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)))) WITH CHECK (((attempt_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text)) OR (state_hash = NULLIF(current_setting('app.oauth_lookup_hash'::text, true), ''::text))));

-- row security: operator_profiles
ALTER TABLE public.operator_profiles ENABLE ROW LEVEL SECURITY;

-- policy: operator_profiles operator_profiles_tenant
CREATE POLICY operator_profiles_tenant ON public.operator_profiles TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: operator_profiles operator_profiles_worker
CREATE POLICY operator_profiles_worker ON public.operator_profiles TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: organization_agent_templates
ALTER TABLE public.organization_agent_templates ENABLE ROW LEVEL SECURITY;

-- policy: organization_agent_templates organization_agent_templates_tenant
CREATE POLICY organization_agent_templates_tenant ON public.organization_agent_templates TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: organization_member_invitations
ALTER TABLE public.organization_member_invitations ENABLE ROW LEVEL SECURITY;

-- policy: organization_member_invitations organization_member_invitations_api
CREATE POLICY organization_member_invitations_api ON public.organization_member_invitations TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (token_hash = NULLIF(current_setting('app.member_invitation_hash'::text, true), ''::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (token_hash = NULLIF(current_setting('app.member_invitation_hash'::text, true), ''::text))));

-- row security: organization_permission_policies
ALTER TABLE public.organization_permission_policies ENABLE ROW LEVEL SECURITY;

-- policy: organization_permission_policies organization_permission_policies_tenant
CREATE POLICY organization_permission_policies_tenant ON public.organization_permission_policies FOR SELECT TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: organization_permission_policies organization_permission_policies_worker
CREATE POLICY organization_permission_policies_worker ON public.organization_permission_policies FOR SELECT TO openedbot_worker USING (true);

-- row security: organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- policy: organizations organizations_tenant
CREATE POLICY organizations_tenant ON public.organizations TO openedbot_api USING ((id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: organizations organizations_worker
CREATE POLICY organizations_worker ON public.organizations TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: playbooks
ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;

-- policy: playbooks playbooks_tenant
CREATE POLICY playbooks_tenant ON public.playbooks TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: playbooks playbooks_worker
CREATE POLICY playbooks_worker ON public.playbooks TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: profile_delete_jobs
ALTER TABLE public.profile_delete_jobs ENABLE ROW LEVEL SECURITY;

-- policy: profile_delete_jobs profile_delete_jobs_tenant
CREATE POLICY profile_delete_jobs_tenant ON public.profile_delete_jobs TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: profile_delete_jobs profile_delete_jobs_worker
CREATE POLICY profile_delete_jobs_worker ON public.profile_delete_jobs TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: profile_import_items
ALTER TABLE public.profile_import_items ENABLE ROW LEVEL SECURITY;

-- policy: profile_import_items profile_import_items_tenant
CREATE POLICY profile_import_items_tenant ON public.profile_import_items TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: profile_import_items profile_import_items_worker
CREATE POLICY profile_import_items_worker ON public.profile_import_items TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: profile_import_jobs
ALTER TABLE public.profile_import_jobs ENABLE ROW LEVEL SECURITY;

-- policy: profile_import_jobs profile_import_jobs_tenant
CREATE POLICY profile_import_jobs_tenant ON public.profile_import_jobs TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: profile_import_jobs profile_import_jobs_worker
CREATE POLICY profile_import_jobs_worker ON public.profile_import_jobs TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: push_deliveries
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;

-- policy: push_deliveries push_deliveries_worker
CREATE POLICY push_deliveries_worker ON public.push_deliveries TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: push_outbox
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;

-- policy: push_outbox push_outbox_worker
CREATE POLICY push_outbox_worker ON public.push_outbox TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: push_subscriptions
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- policy: push_subscriptions push_subscriptions_owner
CREATE POLICY push_subscriptions_owner ON public.push_subscriptions TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)));

-- policy: push_subscriptions push_subscriptions_worker
CREATE POLICY push_subscriptions_worker ON public.push_subscriptions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: routine_executions
ALTER TABLE public.routine_executions ENABLE ROW LEVEL SECURITY;

-- policy: routine_executions routine_executions_tenant
CREATE POLICY routine_executions_tenant ON public.routine_executions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: routine_executions routine_executions_worker
CREATE POLICY routine_executions_worker ON public.routine_executions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: routines
ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;

-- policy: routines routines_tenant
CREATE POLICY routines_tenant ON public.routines TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: routines routines_worker
CREATE POLICY routines_worker ON public.routines TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: run_events
ALTER TABLE public.run_events ENABLE ROW LEVEL SECURITY;

-- policy: run_events run_events_tenant
CREATE POLICY run_events_tenant ON public.run_events TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: run_events run_events_worker
CREATE POLICY run_events_worker ON public.run_events TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: run_steering_attempts
ALTER TABLE public.run_steering_attempts ENABLE ROW LEVEL SECURITY;

-- policy: run_steering_attempts run_steering_attempts_api
CREATE POLICY run_steering_attempts_api ON public.run_steering_attempts TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: run_steering_attempts run_steering_attempts_worker
CREATE POLICY run_steering_attempts_worker ON public.run_steering_attempts TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runs
ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

-- policy: runs runs_tenant
CREATE POLICY runs_tenant ON public.runs TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runs runs_worker
CREATE POLICY runs_worker ON public.runs TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_a2a_audit
ALTER TABLE public.runtime_a2a_audit ENABLE ROW LEVEL SECURITY;

-- policy: runtime_a2a_audit runtime_a2a_audit_tenant
CREATE POLICY runtime_a2a_audit_tenant ON public.runtime_a2a_audit TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_audit_anchors
ALTER TABLE public.runtime_audit_anchors ENABLE ROW LEVEL SECURITY;

-- policy: runtime_audit_anchors runtime_audit_anchors_api
CREATE POLICY runtime_audit_anchors_api ON public.runtime_audit_anchors TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_audit_anchors.runtime_id) AND (r.organization_id = runtime_audit_anchors.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now())))))))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_audit_anchors.runtime_id) AND (r.organization_id = runtime_audit_anchors.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now()))))))));

-- row security: runtime_audit_keys
ALTER TABLE public.runtime_audit_keys ENABLE ROW LEVEL SECURITY;

-- policy: runtime_audit_keys runtime_audit_keys_api
CREATE POLICY runtime_audit_keys_api ON public.runtime_audit_keys TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_audit_keys.runtime_id) AND (r.organization_id = runtime_audit_keys.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now())))))))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_audit_keys.runtime_id) AND (r.organization_id = runtime_audit_keys.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now()))))))));

-- row security: runtime_audit_verifications
ALTER TABLE public.runtime_audit_verifications ENABLE ROW LEVEL SECURITY;

-- policy: runtime_audit_verifications runtime_audit_verifications_tenant
CREATE POLICY runtime_audit_verifications_tenant ON public.runtime_audit_verifications TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_bot_settings_tools
ALTER TABLE public.runtime_bot_settings_tools ENABLE ROW LEVEL SECURITY;

-- policy: runtime_bot_settings_tools runtime_bot_settings_tools_tenant
CREATE POLICY runtime_bot_settings_tools_tenant ON public.runtime_bot_settings_tools TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_bot_settings_tools runtime_bot_settings_tools_worker
CREATE POLICY runtime_bot_settings_tools_worker ON public.runtime_bot_settings_tools FOR SELECT TO openedbot_worker USING (true);

-- row security: runtime_connector_notices
ALTER TABLE public.runtime_connector_notices ENABLE ROW LEVEL SECURITY;

-- policy: runtime_connector_notices runtime_connector_notices_api
CREATE POLICY runtime_connector_notices_api ON public.runtime_connector_notices FOR INSERT TO openedbot_api WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_connector_notices runtime_connector_notices_worker
CREATE POLICY runtime_connector_notices_worker ON public.runtime_connector_notices TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_connector_release_seen
ALTER TABLE public.runtime_connector_release_seen ENABLE ROW LEVEL SECURITY;

-- policy: runtime_connector_release_seen runtime_connector_release_seen_member
CREATE POLICY runtime_connector_release_seen_member ON public.runtime_connector_release_seen TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)));

-- row security: runtime_direct_exposures
ALTER TABLE public.runtime_direct_exposures ENABLE ROW LEVEL SECURITY;

-- policy: runtime_direct_exposures runtime_direct_exposures_tenant
CREATE POLICY runtime_direct_exposures_tenant ON public.runtime_direct_exposures TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_direct_exposures runtime_direct_exposures_worker
CREATE POLICY runtime_direct_exposures_worker ON public.runtime_direct_exposures TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_enrollments
ALTER TABLE public.runtime_enrollments ENABLE ROW LEVEL SECURITY;

-- policy: runtime_enrollments runtime_enrollments_credential
CREATE POLICY runtime_enrollments_credential ON public.runtime_enrollments TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (secret_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (secret_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text))));

-- policy: runtime_enrollments runtime_enrollments_worker
CREATE POLICY runtime_enrollments_worker ON public.runtime_enrollments TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_link_alerts
ALTER TABLE public.runtime_link_alerts ENABLE ROW LEVEL SECURITY;

-- policy: runtime_link_alerts runtime_link_alerts_tenant
CREATE POLICY runtime_link_alerts_tenant ON public.runtime_link_alerts TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_link_alerts runtime_link_alerts_worker
CREATE POLICY runtime_link_alerts_worker ON public.runtime_link_alerts TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_link_diagnostics
ALTER TABLE public.runtime_link_diagnostics ENABLE ROW LEVEL SECURITY;

-- policy: runtime_link_diagnostics runtime_link_diagnostics_tenant
CREATE POLICY runtime_link_diagnostics_tenant ON public.runtime_link_diagnostics TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_link_dispatches
ALTER TABLE public.runtime_link_dispatches ENABLE ROW LEVEL SECURITY;

-- policy: runtime_link_dispatches runtime_link_dispatches_api
CREATE POLICY runtime_link_dispatches_api ON public.runtime_link_dispatches TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_link_dispatches.runtime_id) AND (r.organization_id = runtime_link_dispatches.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now())))))))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (EXISTS ( SELECT 1
   FROM public.runtimes r
  WHERE ((r.id = runtime_link_dispatches.runtime_id) AND (r.organization_id = runtime_link_dispatches.organization_id) AND ((r.link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR ((r.link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) AND (r.link_token_previous_expires_at > now()))))))));

-- row security: runtime_link_events
ALTER TABLE public.runtime_link_events ENABLE ROW LEVEL SECURITY;

-- policy: runtime_link_events runtime_link_events_tenant
CREATE POLICY runtime_link_events_tenant ON public.runtime_link_events TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_link_events runtime_link_events_worker
CREATE POLICY runtime_link_events_worker ON public.runtime_link_events TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_model_proven
ALTER TABLE public.runtime_model_proven ENABLE ROW LEVEL SECURITY;

-- policy: runtime_model_proven runtime_model_proven_tenant
CREATE POLICY runtime_model_proven_tenant ON public.runtime_model_proven TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_model_proven runtime_model_proven_worker
CREATE POLICY runtime_model_proven_worker ON public.runtime_model_proven TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_model_selection_proofs
ALTER TABLE public.runtime_model_selection_proofs ENABLE ROW LEVEL SECURITY;

-- policy: runtime_model_selection_proofs runtime_model_selection_proofs_tenant
CREATE POLICY runtime_model_selection_proofs_tenant ON public.runtime_model_selection_proofs TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_model_selection_proofs runtime_model_selection_proofs_worker
CREATE POLICY runtime_model_selection_proofs_worker ON public.runtime_model_selection_proofs TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_permission_settings
ALTER TABLE public.runtime_permission_settings ENABLE ROW LEVEL SECURITY;

-- policy: runtime_permission_settings runtime_permission_settings_tenant
CREATE POLICY runtime_permission_settings_tenant ON public.runtime_permission_settings TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_permission_settings runtime_permission_settings_worker
CREATE POLICY runtime_permission_settings_worker ON public.runtime_permission_settings FOR SELECT TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_provider_incidents
ALTER TABLE public.runtime_provider_incidents ENABLE ROW LEVEL SECURITY;

-- policy: runtime_provider_incidents runtime_provider_incidents_tenant
CREATE POLICY runtime_provider_incidents_tenant ON public.runtime_provider_incidents TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_provider_incidents runtime_provider_incidents_worker
CREATE POLICY runtime_provider_incidents_worker ON public.runtime_provider_incidents TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_read_snapshots
ALTER TABLE public.runtime_read_snapshots ENABLE ROW LEVEL SECURITY;

-- policy: runtime_read_snapshots runtime_read_snapshots_tenant
CREATE POLICY runtime_read_snapshots_tenant ON public.runtime_read_snapshots TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: runtime_review_profiles
ALTER TABLE public.runtime_review_profiles ENABLE ROW LEVEL SECURITY;

-- policy: runtime_review_profiles runtime_review_profiles_tenant
CREATE POLICY runtime_review_profiles_tenant ON public.runtime_review_profiles FOR SELECT TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_review_profiles runtime_review_profiles_worker
CREATE POLICY runtime_review_profiles_worker ON public.runtime_review_profiles TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: runtime_routine_tools
ALTER TABLE public.runtime_routine_tools ENABLE ROW LEVEL SECURITY;

-- policy: runtime_routine_tools runtime_routine_tools_tenant
CREATE POLICY runtime_routine_tools_tenant ON public.runtime_routine_tools TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtime_routine_tools runtime_routine_tools_worker
CREATE POLICY runtime_routine_tools_worker ON public.runtime_routine_tools FOR SELECT TO openedbot_worker USING (true);

-- row security: runtimes
ALTER TABLE public.runtimes ENABLE ROW LEVEL SECURITY;

-- policy: runtimes runtimes_link_credential
CREATE POLICY runtimes_link_credential ON public.runtimes TO openedbot_api USING (((link_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR (link_token_previous_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text))));

-- policy: runtimes runtimes_tenant
CREATE POLICY runtimes_tenant ON public.runtimes TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: runtimes runtimes_worker
CREATE POLICY runtimes_worker ON public.runtimes TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: sections
ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

-- policy: sections sections_tenant
CREATE POLICY sections_tenant ON public.sections TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: sections sections_worker
CREATE POLICY sections_worker ON public.sections TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: sessions
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- policy: sessions sessions_credential
CREATE POLICY sessions_credential ON public.sessions TO openedbot_api USING (((session_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR (access_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR (refresh_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) OR (session_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR (access_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text)) OR (refresh_token_hash = NULLIF(current_setting('app.session_credential_hash'::text, true), ''::text))));

-- policy: sessions sessions_owner_read
CREATE POLICY sessions_owner_read ON public.sessions FOR SELECT TO openedbot_api USING ((user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid));

-- policy: sessions sessions_owner_revoke
CREATE POLICY sessions_owner_revoke ON public.sessions FOR UPDATE TO openedbot_api USING ((user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)) WITH CHECK ((user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid));

-- policy: staff_impersonation_claims staff_impersonation_claim_consume
CREATE POLICY staff_impersonation_claim_consume ON public.staff_impersonation_claims FOR UPDATE TO openedbot_api USING ((claim_token_hash = NULLIF(current_setting('app.staff_impersonation_claim_hash'::text, true), ''::text))) WITH CHECK ((claim_token_hash = NULLIF(current_setting('app.staff_impersonation_claim_hash'::text, true), ''::text)));

-- policy: staff_impersonation_claims staff_impersonation_claim_token
CREATE POLICY staff_impersonation_claim_token ON public.staff_impersonation_claims FOR SELECT TO openedbot_api USING ((claim_token_hash = NULLIF(current_setting('app.staff_impersonation_claim_hash'::text, true), ''::text)));

-- row security: staff_impersonation_claims
ALTER TABLE public.staff_impersonation_claims ENABLE ROW LEVEL SECURITY;

-- row security: staff_login_codes
ALTER TABLE public.staff_login_codes ENABLE ROW LEVEL SECURITY;

-- policy: staff_login_codes staff_login_codes_api
CREATE POLICY staff_login_codes_api ON public.staff_login_codes TO openedbot_api USING (((staff_user_id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid) OR (staff_user_id IN ( SELECT staff_users.id
   FROM public.staff_users
  WHERE (lower(staff_users.email) = NULLIF(current_setting('app.staff_email'::text, true), ''::text)))))) WITH CHECK (((staff_user_id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid) OR (staff_user_id IN ( SELECT staff_users.id
   FROM public.staff_users
  WHERE (lower(staff_users.email) = NULLIF(current_setting('app.staff_email'::text, true), ''::text))))));

-- row security: staff_sessions
ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;

-- policy: staff_sessions staff_sessions_api
CREATE POLICY staff_sessions_api ON public.staff_sessions TO openedbot_api USING (((session_token_hash = NULLIF(current_setting('app.staff_session_hash'::text, true), ''::text)) OR (staff_user_id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((session_token_hash = NULLIF(current_setting('app.staff_session_hash'::text, true), ''::text)) OR (staff_user_id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid)));

-- row security: staff_users
ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;

-- policy: staff_users staff_users_api
CREATE POLICY staff_users_api ON public.staff_users TO openedbot_api USING (((id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid) OR (lower(email) = NULLIF(current_setting('app.staff_email'::text, true), ''::text)))) WITH CHECK ((id = (NULLIF(current_setting('app.staff_user_id'::text, true), ''::text))::uuid));

-- row security: subscriptions
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- policy: subscriptions subscriptions_tenant
CREATE POLICY subscriptions_tenant ON public.subscriptions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: subscriptions subscriptions_worker
CREATE POLICY subscriptions_worker ON public.subscriptions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: support_attachments
ALTER TABLE public.support_attachments ENABLE ROW LEVEL SECURITY;

-- policy: support_attachments support_attachments_scope
CREATE POLICY support_attachments_scope ON public.support_attachments TO openedbot_api USING ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_attachments.conversation_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_attachments.conversation_id))));

-- policy: support_attachments support_attachments_worker
CREATE POLICY support_attachments_worker ON public.support_attachments TO openedbot_worker USING (true) WITH CHECK (true);

-- policy: tenant_blob_deletions support_blob_deletions_api
CREATE POLICY support_blob_deletions_api ON public.tenant_blob_deletions TO openedbot_api USING (((object_key ~~ 'support/%'::text) AND (organization_id IS NULL))) WITH CHECK (((object_key ~~ 'support/%'::text) AND (organization_id IS NULL)));

-- row security: support_conversations
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;

-- policy: support_conversations support_conversations_account
CREATE POLICY support_conversations_account ON public.support_conversations TO openedbot_api USING (((user_id IS NOT NULL) AND (user_id = (NULLIF(current_setting('app.support_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((user_id IS NOT NULL) AND (user_id = (NULLIF(current_setting('app.support_user_id'::text, true), ''::text))::uuid)));

-- comment: POLICY support_conversations_account ON support_conversations
COMMENT ON POLICY support_conversations_account ON public.support_conversations IS 'La porte COMPTE : les fils ouverts par un opérateur connecté suivent son compte, pas son navigateur. `app.support_user_id` est posé par withSupportUser après validation de la session.';

-- policy: support_conversations support_conversations_guest
CREATE POLICY support_conversations_guest ON public.support_conversations TO openedbot_api USING ((guest_token_hash = NULLIF(current_setting('app.support_guest_token_hash'::text, true), ''::text))) WITH CHECK ((guest_token_hash = NULLIF(current_setting('app.support_guest_token_hash'::text, true), ''::text)));

-- policy: support_conversations support_conversations_staff
CREATE POLICY support_conversations_staff ON public.support_conversations TO openedbot_api USING (public.support_staff_session()) WITH CHECK (public.support_staff_session());

-- policy: support_conversations support_conversations_worker
CREATE POLICY support_conversations_worker ON public.support_conversations TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: support_events
ALTER TABLE public.support_events ENABLE ROW LEVEL SECURITY;

-- policy: support_events support_events_scope
CREATE POLICY support_events_scope ON public.support_events TO openedbot_api USING ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_events.conversation_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_events.conversation_id))));

-- policy: support_events support_events_worker
CREATE POLICY support_events_worker ON public.support_events TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: support_messages
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- policy: support_messages support_messages_scope
CREATE POLICY support_messages_scope ON public.support_messages TO openedbot_api USING ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_messages.conversation_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.support_conversations c
  WHERE (c.id = support_messages.conversation_id))));

-- row security: team_imports
ALTER TABLE public.team_imports ENABLE ROW LEVEL SECURITY;

-- policy: team_imports team_imports_tenant
CREATE POLICY team_imports_tenant ON public.team_imports TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: tenant_blob_deletions
ALTER TABLE public.tenant_blob_deletions ENABLE ROW LEVEL SECURITY;

-- policy: tenant_blob_deletions tenant_blob_deletions_worker
CREATE POLICY tenant_blob_deletions_worker ON public.tenant_blob_deletions TO openedbot_worker USING (true) WITH CHECK (true);

-- policy: tenant_blob_deletions tenant_blob_reservations_api
CREATE POLICY tenant_blob_reservations_api ON public.tenant_blob_deletions TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (object_key ~~ (('org/'::text || (organization_id)::text) || '/%'::text)))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (object_key ~~ (('org/'::text || (organization_id)::text) || '/%'::text))));

-- row security: tenant_deletions
ALTER TABLE public.tenant_deletions ENABLE ROW LEVEL SECURITY;

-- policy: tenant_deletions tenant_deletions_tenant
CREATE POLICY tenant_deletions_tenant ON public.tenant_deletions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: tenant_deletions tenant_deletions_worker
CREATE POLICY tenant_deletions_worker ON public.tenant_deletions TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: thread_compactions
ALTER TABLE public.thread_compactions ENABLE ROW LEVEL SECURITY;

-- policy: thread_compactions thread_compactions_tenant
CREATE POLICY thread_compactions_tenant ON public.thread_compactions TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: thread_compactions thread_compactions_worker
CREATE POLICY thread_compactions_worker ON public.thread_compactions TO openedbot_worker USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: thread_hides
ALTER TABLE public.thread_hides ENABLE ROW LEVEL SECURITY;

-- policy: thread_hides thread_hides_tenant
CREATE POLICY thread_hides_tenant ON public.thread_hides TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: thread_message_counters
ALTER TABLE public.thread_message_counters ENABLE ROW LEVEL SECURITY;

-- policy: thread_message_counters thread_message_counters_tenant
CREATE POLICY thread_message_counters_tenant ON public.thread_message_counters TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: thread_message_counters thread_message_counters_worker
CREATE POLICY thread_message_counters_worker ON public.thread_message_counters TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: thread_reads
ALTER TABLE public.thread_reads ENABLE ROW LEVEL SECURITY;

-- policy: thread_reads thread_reads_tenant
CREATE POLICY thread_reads_tenant ON public.thread_reads TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: threads
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;

-- policy: threads threads_tenant
CREATE POLICY threads_tenant ON public.threads TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: threads threads_worker
CREATE POLICY threads_worker ON public.threads TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: tool_errors
ALTER TABLE public.tool_errors ENABLE ROW LEVEL SECURITY;

-- policy: tool_errors tool_errors_tenant
CREATE POLICY tool_errors_tenant ON public.tool_errors TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: tool_errors tool_errors_worker
CREATE POLICY tool_errors_worker ON public.tool_errors TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: user_workspace_preferences
ALTER TABLE public.user_workspace_preferences ENABLE ROW LEVEL SECURITY;

-- policy: user_workspace_preferences user_workspace_preferences_personal
CREATE POLICY user_workspace_preferences_personal ON public.user_workspace_preferences TO openedbot_api USING (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid))) WITH CHECK (((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.authenticating_user_id'::text, true), ''::text))::uuid)));

-- row security: webhook_deliveries
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- policy: webhook_deliveries webhook_deliveries_tenant
CREATE POLICY webhook_deliveries_tenant ON public.webhook_deliveries TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: webhook_endpoints
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- policy: webhook_endpoints webhook_endpoints_tenant
CREATE POLICY webhook_endpoints_tenant ON public.webhook_endpoints TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: webhook_management_operations
ALTER TABLE public.webhook_management_operations ENABLE ROW LEVEL SECURITY;

-- policy: webhook_management_operations webhook_management_operations_tenant
CREATE POLICY webhook_management_operations_tenant ON public.webhook_management_operations TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- row security: workflows
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

-- policy: workflows workflows_tenant
CREATE POLICY workflows_tenant ON public.workflows TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

-- policy: workflows workflows_worker
CREATE POLICY workflows_worker ON public.workflows TO openedbot_worker USING (true) WITH CHECK (true);

-- row security: workspace_activation
ALTER TABLE public.workspace_activation ENABLE ROW LEVEL SECURITY;

-- policy: workspace_activation workspace_activation_tenant
CREATE POLICY workspace_activation_tenant ON public.workspace_activation TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));

INSERT INTO schema_migrations(version) VALUES ('0008_row_level_security') ON CONFLICT DO NOTHING;

COMMIT;
