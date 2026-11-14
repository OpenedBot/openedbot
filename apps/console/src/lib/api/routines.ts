import type { BotRoutineToolDto, BotSettingProposalDecisionInput, BotSettingProposalDto, BotSettingsToolDto, CreateRoutineInput, RoutineDto, RoutineExecutionPageDto, RoutineExecutionReceiptPageDto, RoutineRunAcceptedDto, UpdateRoutineInput, WorkflowStatus } from "@openedbot/contracts-api";
import { request } from "./http";

export const routinesApi = {
  /** A bot's routines: the cloud scheduler, not the Hermes runtime's cron. */
  routines: (botId: string) => request<{ routines: RoutineDto[] }>(`/api/bots/${botId}/routines`),
  groupRoutines: (groupId: string) => request<{ routines: RoutineDto[] }>(`/api/groups/${groupId}/routines`),
  /** `routine_manage` (DEV-209): the bot manages its own routines. */
  botRoutineTool: (botId: string) => request<BotRoutineToolDto>(`/api/bots/${botId}/routine-tool`),
  setBotRoutineTool: (botId: string, enabled: boolean) =>
    request<BotRoutineToolDto>(`/api/bots/${botId}/routine-tool`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  /** `bot_settings_propose`: the bot PROPOSES, the operator decides. */
  botSettingsTool: (botId: string) => request<BotSettingsToolDto>(`/api/bots/${botId}/settings-tool`),
  setBotSettingsTool: (botId: string, enabled: boolean) =>
    request<BotSettingsToolDto>(`/api/bots/${botId}/settings-tool`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  decideBotSettingProposal: (botId: string, proposalId: string, input: BotSettingProposalDecisionInput) =>
    request<BotSettingProposalDto>(`/api/bots/${botId}/setting-proposals/${proposalId}/decision`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createRoutine: (botId: string, input: CreateRoutineInput) =>
    request<RoutineDto>(`/api/bots/${botId}/routines`, { method: "POST", body: JSON.stringify(input) }),
  createGroupRoutine: (groupId: string, input: CreateRoutineInput) =>
    request<RoutineDto>(`/api/groups/${groupId}/routines`, { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (routineId: string, input: UpdateRoutineInput) =>
    request<RoutineDto>(`/api/routines/${routineId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRoutine: (routineId: string) =>
    request<void>(`/api/routines/${routineId}`, { method: "DELETE" }),
  /**
   * A one-off occurrence is a detached workflow. The key stays that of
   * the logical gesture so an HTTP timeout cannot start it twice.
   */
  runRoutine: (routineId: string, idempotencyKey: string) =>
    request<RoutineRunAcceptedDto>(`/api/routines/${routineId}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  /** Firing receipts, paginated by the opaque key the API returns. */
  routineReceipts: (input: {
    routineId?: string | null;
    status?: WorkflowStatus | null;
    cursor?: string | null;
    limit?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (input.routineId) query.set("routineId", input.routineId);
    if (input.status) query.set("status", input.status);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<RoutineExecutionReceiptPageDto>(`/api/routines/receipts${suffix}`);
  },
  routineExecutions: (routineId: string, input: { cursor?: string | null; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<RoutineExecutionPageDto>(`/api/routines/${routineId}/executions${suffix}`);
  },
};
