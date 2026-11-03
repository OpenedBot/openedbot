import type { BotRoutineToolDto, BotSettingProposalDecisionInput, BotSettingProposalDto, BotSettingsToolDto, CreateRoutineInput, RoutineDto, RoutineExecutionPageDto, RoutineExecutionReceiptPageDto, RoutineRunAcceptedDto, UpdateRoutineInput, WorkflowStatus } from "@openedbot/contracts-api";
import { request } from "./http";

export const routinesApi = {
  /** Routines d'un bot: le planificateur cloud, pas le cron du runtime Hermes. */
  routines: (botId: string) => request<{ routines: RoutineDto[] }>(`/api/bots/${botId}/routines`),
  groupRoutines: (groupId: string) => request<{ routines: RoutineDto[] }>(`/api/groups/${groupId}/routines`),
  /** `routine_manage` (DEV-209) : le bot gère lui-même ses routines. */
  botRoutineTool: (botId: string) => request<BotRoutineToolDto>(`/api/bots/${botId}/routine-tool`),
  setBotRoutineTool: (botId: string, enabled: boolean) =>
    request<BotRoutineToolDto>(`/api/bots/${botId}/routine-tool`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  /** `bot_settings_propose` : le bot PROPOSE, l'opérateur décide. */
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
   * Une occurrence ponctuelle est un workflow détaché. La clé reste celle
   * du geste logique afin qu'un timeout HTTP ne puisse pas lancer deux fois.
   */
  runRoutine: (routineId: string, idempotencyKey: string) =>
    request<RoutineRunAcceptedDto>(`/api/routines/${routineId}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  /** Reçus de tirs, paginés par la clé opaque rendue par l'API. */
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
