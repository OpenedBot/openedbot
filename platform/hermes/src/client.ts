import type { A2aAgentCard } from "@openedbot/contracts-connector";
import type { A2AAuditHostSnapshot } from "./a2a-audit";
import * as a2a from "./client/a2a";
import * as capabilities from "./client/capabilities";
import * as mcp from "./client/mcp";
import * as profiles from "./client/profiles";
import * as providers from "./client/providers";
import * as runs from "./client/runs";
import * as sessions from "./client/sessions";
import * as skillsHub from "./client/skills-hub";
import { createHermesClientContext, type HermesClientContext } from "./client/context";
import { directResponseEvidence, type DirectResponseEvidence } from "./client/evidence";
import { resolveHermesTimeouts } from "./client/timeouts";
import type {
  HermesApprovalPolicyMode,
  HermesApprovalPolicyState,
  HermesClientConfig,
  A2APolicyView,
  A2APolicyWriteStatus,
  CreateHermesRunInput,
  HermesBrowserControlTransportProbe,
  HermesCapabilityInventory,
  HermesConnectorManagementProbe,
  HermesEvent,
  HermesGatewayRestartJob,
  HermesGatewayStatus,
  HermesCreatedHostProfile,
  HermesHostProfileCreateOptions,
  HermesHostToolsets,
  HermesProviderSdk,
  HermesMcpInventory,
  HermesMcpOauthSession,
  HermesMcpServer,
  HermesMcpServerRequest,
  HermesModelContext,
  HermesModelOptions,
  HermesProfileAvatar,
  HermesProfileCredentialResult,
  HermesProfileInventory,
  HermesProfileIsolation,
  HermesProfileMcpServerState,
  HermesProfileMcpServerRemoval,
  HermesProfileMemory,
  HermesProfileMemoryWrite,
  HermesProfileModelState,
  HermesProfileModelBatchEntry,
  HermesProfileSkillState,
  HermesProfileBundledSkillsState,
  HermesProfileSkillsHubDelete,
  HermesSkillsHubInspection,
  HermesSkillsHubOperation,
  HermesSkillsHubScan,
  HermesSkillsHubSearchResult,
  HermesProfileToolsetState,
  HermesProviderCredentialResult,
  HermesProviderOauthSession,
  HermesProviderUsageDocument,
  HermesRunDetails,
  HermesSessionCounters,
  HermesToolset,
  HermesToolsetState,
  SteerHermesRunInput,
} from "./contracts";
import { assertHermesMtlsRuntime } from "./mtls";
import type { HermesPreflightScope, HermesToolsetInventoryScope } from "./preflight-cache";
import { createDirectTransport } from "./transport/direct";
import type { HermesTransport } from "./transport/types";

export { fitHermesRunImages, hermesRunRequestBody } from "./client/run-body";

export class HermesClient {
  private readonly ctx: HermesClientContext;

  constructor(config: HermesClientConfig) {
    let transport: HermesTransport;
    if ("transport" in config) {
      transport = config.transport;
    } else {
      if (config.mtls) assertHermesMtlsRuntime();
      transport = createDirectTransport(config);
    }
    this.ctx = createHermesClientContext({
      config,
      transport,
      timeouts: resolveHermesTimeouts(config.timeouts),
      withProfile: (profile) => new HermesClient({ ...config, profile }).ctx,
    });
  }

  static directResponseEvidence(error: unknown): DirectResponseEvidence | null {
    return directResponseEvidence(error);
  }

  async health(): Promise<unknown> {
    return capabilities.health(this.ctx);
  }

  async capabilities(): Promise<unknown> {
    return capabilities.capabilities(this.ctx);
  }

  async probe(): Promise<{ health: unknown; capabilities: unknown }> {
    return capabilities.probe(this.ctx);
  }

  async runSteerSupported(): Promise<boolean> {
    return capabilities.runSteerSupported(this.ctx);
  }

  async probeProfileIsolation(slug: string): Promise<HermesProfileIsolation> {
    return capabilities.probeProfileIsolation(this.ctx, slug);
  }

  async models(): Promise<Array<{ id: string }>> {
    return capabilities.models(this.ctx);
  }

  async modelOptions(): Promise<HermesModelOptions> {
    return capabilities.modelOptions(this.ctx);
  }

  async hostCapabilities(): Promise<string[] | null> {
    return capabilities.hostCapabilities(this.ctx);
  }

  async hostProviderSdks(): Promise<HermesProviderSdk[]> {
    return capabilities.hostProviderSdks(this.ctx);
  }

  async a2aAgentCard(): Promise<A2aAgentCard> {
    return a2a.a2aAgentCard(this.ctx);
  }

  async a2aAudit(limit?: number): Promise<A2AAuditHostSnapshot> {
    return a2a.a2aAudit(this.ctx, limit);
  }

  async a2aPolicy(): Promise<A2APolicyView> {
    return a2a.a2aPolicy(this.ctx);
  }

  async a2aTrustPeer(name: string, trusted: boolean): Promise<A2APolicyWriteStatus> {
    return a2a.a2aTrustPeer(this.ctx, name, trusted);
  }

  async a2aSetPeerToken(name: string, token: string): Promise<A2APolicyWriteStatus> {
    return a2a.a2aSetPeerToken(this.ctx, name, token);
  }

  async a2aDeletePeerToken(name: string): Promise<A2APolicyWriteStatus> {
    return a2a.a2aDeletePeerToken(this.ctx, name);
  }

  async providerUsage(options?: { refresh?: boolean }): Promise<HermesProviderUsageDocument> {
    return providers.providerUsage(this.ctx, options);
  }

  async modelContext(options?: { profile?: string }): Promise<HermesModelContext> {
    return providers.modelContext(this.ctx, options);
  }

  async providerCredentialAdd(
    provider: string,
    apiKey: string,
    label?: string,
  ): Promise<HermesProviderCredentialResult> {
    return providers.providerCredentialAdd(this.ctx, provider, apiKey, label);
  }

  async providerOauthStart(provider: string): Promise<HermesProviderOauthSession> {
    return providers.providerOauthStart(this.ctx, provider);
  }

  async providerOauthPoll(provider: string, sessionId: string): Promise<HermesProviderOauthSession> {
    return providers.providerOauthPoll(this.ctx, provider, sessionId);
  }

  async providerOauthCancel(provider: string, sessionId: string): Promise<void> {
    return providers.providerOauthCancel(this.ctx, provider, sessionId);
  }

  async hostToolsets(): Promise<HermesHostToolsets> {
    return capabilities.hostToolsets(this.ctx);
  }

  async hostProfileInventory(): Promise<HermesProfileInventory> {
    return profiles.hostProfileInventory(this.ctx);
  }

  async hostProfileAvatar(slug: string): Promise<HermesProfileAvatar> {
    return profiles.hostProfileAvatar(this.ctx, slug);
  }

  async hostCreateProfile(
    name: string,
    displayNameOrOptions?: string | HermesHostProfileCreateOptions,
  ): Promise<HermesCreatedHostProfile> {
    return profiles.hostCreateProfile(this.ctx, name, displayNameOrOptions);
  }

  async hostSetProfileModel(
    profile: string,
    selection: { provider: string; model: string },
  ): Promise<HermesProfileModelState> {
    return profiles.hostSetProfileModel(this.ctx, profile, selection);
  }

  async hostSetProfileModels(
    profileNames: readonly string[],
    selection: { provider: string; model: string },
  ): Promise<HermesProfileModelBatchEntry[]> {
    return profiles.hostSetProfileModels(this.ctx, profileNames, selection);
  }

  async hostDeleteProfile(slug: string): Promise<void> {
    return profiles.hostDeleteProfile(this.ctx, slug);
  }

  async hostSetProfileToolset(
    profile: string,
    name: string,
    enabled: boolean,
  ): Promise<HermesProfileToolsetState> {
    return profiles.hostSetProfileToolset(this.ctx, profile, name, enabled);
  }

  async hostApprovalPolicy(slug: string): Promise<HermesApprovalPolicyState> {
    return profiles.hostApprovalPolicy(this.ctx, slug);
  }

  async hostSetApprovalPolicy(slug: string, mode: HermesApprovalPolicyMode, blockedTools?: readonly string[]): Promise<HermesApprovalPolicyState> {
    return profiles.hostSetApprovalPolicy(this.ctx, slug, mode, blockedTools);
  }

  async hostProfileMemory(profile: string): Promise<HermesProfileMemory> {
    return profiles.hostProfileMemory(this.ctx, profile);
  }

  async hostWriteProfileMemory(
    profile: string,
    write: HermesProfileMemoryWrite,
  ): Promise<HermesProfileMemory> {
    return profiles.hostWriteProfileMemory(this.ctx, profile, write);
  }

  async hostSetProfileMcpServer(
    profile: string,
    name: string,
    enabled: boolean,
  ): Promise<HermesProfileMcpServerState> {
    return profiles.hostSetProfileMcpServer(this.ctx, profile, name, enabled);
  }

  async hostRemoveProfileMcpServer(profile: string, name: string): Promise<HermesProfileMcpServerRemoval> {
    return profiles.hostRemoveProfileMcpServer(this.ctx, profile, name);
  }

  async hostSetProfileSkill(
    profile: string,
    name: string,
    enabled: boolean,
  ): Promise<HermesProfileSkillState> {
    return profiles.hostSetProfileSkill(this.ctx, profile, name, enabled);
  }

  async hostSetProfileBundledSkills(
    profile: string,
    enabled: boolean,
  ): Promise<HermesProfileBundledSkillsState> {
    return profiles.hostSetProfileBundledSkills(this.ctx, profile, enabled);
  }

  async skillsHubSearch(query: string, options?: { source?: string; limit?: number }): Promise<HermesSkillsHubSearchResult[]> {
    return skillsHub.skillsHubSearch(this.ctx, query, options);
  }

  async skillsHubInspect(identifier: string): Promise<HermesSkillsHubInspection> {
    return skillsHub.skillsHubInspect(this.ctx, identifier);
  }

  async skillsHubScan(profile: string, identifier: string): Promise<HermesSkillsHubScan> {
    return skillsHub.skillsHubScan(this.ctx, profile, identifier);
  }

  async skillsHubInstall(profile: string, identifier: string): Promise<{ operationId: string }> {
    return skillsHub.skillsHubInstall(this.ctx, profile, identifier);
  }

  async skillsHubOperation(profile: string, operationId: string): Promise<HermesSkillsHubOperation> {
    return skillsHub.skillsHubOperation(this.ctx, profile, operationId);
  }

  async hostDeleteProfileSkill(profile: string, skill: string): Promise<HermesProfileSkillsHubDelete> {
    return skillsHub.hostDeleteProfileSkill(this.ctx, profile, skill);
  }

  async hostSetProfileCredential(
    profile: string,
    provider: string,
    apiKey: string,
    label?: string,
  ): Promise<HermesProfileCredentialResult> {
    return profiles.hostSetProfileCredential(this.ctx, profile, provider, apiKey, label);
  }

  async hostDeleteProfileCredential(
    profile: string,
    provider: string,
  ): Promise<HermesProfileCredentialResult> {
    return profiles.hostDeleteProfileCredential(this.ctx, profile, provider);
  }

  async toolsetSet(name: string, enabled: boolean): Promise<HermesToolsetState> {
    return capabilities.toolsetSet(this.ctx, name, enabled);
  }

  async mcpInventory(): Promise<HermesMcpInventory> {
    return mcp.mcpInventory(this.ctx);
  }

  async mcpServerAdd(request: HermesMcpServerRequest): Promise<HermesMcpServer> {
    return mcp.mcpServerAdd(this.ctx, request);
  }

  async mcpCatalogInstall(name: string, env?: Record<string, string>): Promise<HermesMcpServer> {
    return mcp.mcpCatalogInstall(this.ctx, name, env);
  }

  async mcpOauthStart(server: string, redirectUri: string, profile?: string): Promise<HermesMcpOauthSession> {
    return mcp.mcpOauthStart(this.ctx, server, redirectUri, profile);
  }

  async mcpOauthPoll(server: string, sessionId: string): Promise<HermesMcpOauthSession> {
    return mcp.mcpOauthPoll(this.ctx, server, sessionId);
  }

  async mcpOauthCallback(
    server: string,
    callback: { code: string; state: string; iss?: string } | { error: string },
  ): Promise<HermesMcpOauthSession> {
    return mcp.mcpOauthCallback(this.ctx, server, callback);
  }

  async mcpOauthCancel(server: string, sessionId: string): Promise<void> {
    return mcp.mcpOauthCancel(this.ctx, server, sessionId);
  }

  async gatewayStatus(): Promise<HermesGatewayStatus> {
    return mcp.gatewayStatus(this.ctx);
  }

  async gatewayRestart(): Promise<HermesGatewayRestartJob> {
    return mcp.gatewayRestart(this.ctx);
  }

  async gatewayRestartPoll(jobId: string): Promise<HermesGatewayRestartJob> {
    return mcp.gatewayRestartPoll(this.ctx, jobId);
  }

  async mcpServerRemove(name: string): Promise<void> {
    return mcp.mcpServerRemove(this.ctx, name);
  }

  async capabilityInventory(): Promise<HermesCapabilityInventory> {
    return capabilities.capabilityInventory(this.ctx);
  }

  async browserControlTransportProbe(): Promise<HermesBrowserControlTransportProbe> {
    return capabilities.browserControlTransportProbe(this.ctx);
  }

  async connectorManagementProbe(): Promise<HermesConnectorManagementProbe> {
    return capabilities.connectorManagementProbe(this.ctx);
  }

  async toolsets(): Promise<HermesToolset[] | null> {
    return capabilities.toolsets(this.ctx);
  }

  async cachedToolsets(scope: HermesToolsetInventoryScope): Promise<HermesToolset[] | null> {
    return capabilities.cachedToolsets(this.ctx, scope);
  }

  async ensureSession(id: string, title: string, signal?: AbortSignal): Promise<void> {
    return sessions.ensureSession(this.ctx, id, title, signal);
  }

  async createRun(input: CreateHermesRunInput): Promise<string> {
    return runs.createRun(this.ctx, input);
  }

  async getRunStatus(hermesRunId: string, signal?: AbortSignal): Promise<HermesRunDetails> {
    return runs.getRunStatus(this.ctx, hermesRunId, signal);
  }

  async sessionCounters(sessionId: string, signal?: AbortSignal): Promise<HermesSessionCounters> {
    return sessions.sessionCounters(this.ctx, sessionId, signal);
  }

  async sessionMessages(sessionId: string): Promise<unknown[]> {
    return sessions.sessionMessages(this.ctx, sessionId);
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await sessions.deleteSession(this.ctx, sessionId, signal);
  }

  /** Same DELETE, saying whether a session was there (`false`: already absent). */
  async removeSession(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    return sessions.deleteSession(this.ctx, sessionId, signal);
  }

  async eventReplaySupported(scope?: HermesPreflightScope): Promise<boolean> {
    return capabilities.eventReplaySupported(this.ctx, scope);
  }

  peekCachedEventReplay(scope: HermesPreflightScope): boolean | undefined {
    return capabilities.peekCachedEventReplay(this.ctx, scope);
  }

  events(
    hermesRunId: string,
    signal: AbortSignal,
    options?: { since?: number; onOpen?: () => void },
  ): AsyncGenerator<HermesEvent> {
    return runs.events(this.ctx, hermesRunId, signal, options);
  }

  async stopRun(hermesRunId: string, signal?: AbortSignal): Promise<void> {
    return runs.stopRun(this.ctx, hermesRunId, signal);
  }

  async steerRun(hermesRunId: string, input: SteerHermesRunInput): Promise<number> {
    return runs.steerRun(this.ctx, hermesRunId, input);
  }

  async respondApproval(
    hermesRunId: string,
    choice: "once" | "session" | "always" | "deny",
    signal?: AbortSignal,
    requestId?: string | null,
  ): Promise<void> {
    return runs.respondApproval(this.ctx, hermesRunId, choice, signal, requestId);
  }
}
