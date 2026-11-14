import type { BotCapabilitiesDto, BotCapabilityMutationDto, BotComputerCaptureDto, BotComputerDto, BotComputerOpenDto, BotProfileCredentialDto, BotRuntimeMemoryDto, BotRuntimeMemoryWriteInput, BotToolPoliciesDto, BotToolPolicyWrite, PersonaDraftDto, ToolErrorPageDto } from "@openedbot/contracts-api";
import { request } from "./http";

export const botsApi = {
  botCapabilities: (botId: string) =>
    request<BotCapabilitiesDto>(`/api/bots/${botId}/capabilities`),
  botToolPolicies: (botId: string) =>
    request<BotToolPoliciesDto>(`/api/bots/${botId}/tool-policies`),
  setBotToolPolicies: (botId: string, policies: BotToolPolicyWrite[]) =>
    request<BotToolPoliciesDto>(`/api/bots/${botId}/tool-policies`, {
      method: "PATCH",
      body: JSON.stringify({ policies }),
    }),
  setBotToolset: (botId: string, name: string, enabled: boolean) =>
    request<BotCapabilityMutationDto>(`/api/bots/${botId}/capabilities/toolsets/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  setBotMcpServer: (botId: string, name: string, enabled: boolean) =>
    request<BotCapabilityMutationDto>(`/api/bots/${botId}/capabilities/mcp/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  setBotSkill: (botId: string, name: string, enabled: boolean) =>
    request<BotCapabilityMutationDto>(`/api/bots/${botId}/capabilities/skills/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  /** Published agent models (official) and the organization's, according to the active sources. */
  setBotCredential: (botId: string, provider: string, input: { apiKey: string; label?: string }) =>
    request<BotProfileCredentialDto>(`/api/bots/${botId}/credentials/${encodeURIComponent(provider)}`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteBotCredential: (botId: string, provider: string) =>
    request<BotProfileCredentialDto>(`/api/bots/${botId}/credentials/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    }),
  /** A bot's latest tool failures, paginated by the opaque key the API returns (50 max). */
  botToolErrors: (botId: string, input: { cursor?: string | null; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<ToolErrorPageDto>(`/api/bots/${botId}/tool-errors${suffix}`);
  },
  /** A managed-profile bot's runtime memory (the profile's MEMORY.md / USER.md). */
  botRuntimeMemory: (botId: string) =>
    request<BotRuntimeMemoryDto>(`/api/bots/${botId}/runtime-memory`),
  writeBotRuntimeMemory: (botId: string, input: BotRuntimeMemoryWriteInput) =>
    request<BotRuntimeMemoryDto>(`/api/bots/${botId}/runtime-memory`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  botComputer: (botId: string) =>
    request<BotComputerDto>(`/api/bots/${botId}/computer`),
  startBotComputer: (botId: string) =>
    request<BotComputerDto>(`/api/bots/${botId}/computer/start`, { method: "POST", body: "{}" }),
  openBotComputer: (botId: string) =>
    request<BotComputerOpenDto>(`/api/bots/${botId}/computer/open`, { method: "POST", body: "{}" }),
  captureBotComputer: (botId: string) =>
    request<BotComputerCaptureDto>(`/api/bots/${botId}/computer/capture`, { method: "POST", body: "{}" }),
  stopBotComputer: (botId: string) =>
    request<BotComputerDto>(`/api/bots/${botId}/computer/stop`, { method: "POST", body: "{}" }),
  /**
   * Persona draft for a bot that already exists
   * (`POST /api/bots/:botId/persona-drafts`).
   */
  requestPersonaDraft: (botId: string) =>
    request<PersonaDraftDto>(`/api/bots/${botId}/persona-drafts`, { method: "POST", body: "{}" }),
  latestPersonaDraft: (botId: string) =>
    request<PersonaDraftDto>(`/api/bots/${botId}/persona-drafts/latest`),
  confirmPersonaDraft: (botId: string, runId: string, hash: string) =>
    request<PersonaDraftDto>(`/api/bots/${botId}/persona-drafts/${runId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ hash }),
    }),
};
