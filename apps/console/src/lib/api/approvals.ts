import type { ApprovalDecisionInput, ApprovalRespondDto, BotPermissionGrantDto, RuntimePermissionSettingsDto } from "@openedbot/contracts-api";
import { request } from "./http";

export const approvalsApi = {
  respondApproval: (approvalId: string, decision: ApprovalDecisionInput) =>
    request<ApprovalRespondDto>(`/api/approvals/${approvalId}/respond`, {
      method: "POST",
      body: JSON.stringify(decision),
    }),
  /** PERM2-4 : les « Toujours pour cet outil sur ce bot » actifs. */
  botPermissionGrants: (botId: string) =>
    request<BotPermissionGrantDto[]>(`/api/bots/${botId}/permission-grants`),
  revokeBotPermissionGrant: (botId: string, grantId: string) =>
    request<void>(`/api/bots/${botId}/permission-grants/${grantId}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** PERM2-4, D-3 : l'interrupteur des commandes jugées dangereuses, pour tous les bots du runtime. */
  runtimePermissionSettings: (runtimeId: string) =>
    request<RuntimePermissionSettingsDto>(`/api/runtimes/${runtimeId}/permission-settings`),
  setRuntimeTerminalDangerAlways: (runtimeId: string, terminalDangerAlways: boolean) =>
    request<RuntimePermissionSettingsDto>(`/api/runtimes/${runtimeId}/permission-settings`, {
      method: "PUT",
      body: JSON.stringify({ terminalDangerAlways }),
    }),
};
