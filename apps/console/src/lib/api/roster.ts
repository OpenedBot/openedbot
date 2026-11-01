import type { BotDto, BotModelResetDto, BotProfileModelSyncDto, BotProfileRepairDto, BotProfileRepairInput, BotProfileStatusDto, BotPurgeResultDto, RosterDto, UpdateBotInput } from "@openedbot/contracts-api";
import { request } from "./http";
import type { CreateBotInput } from "./types";

export const rosterApi = {
  /** Roster complet : les masqués voyagent aussi ; le client les partitionne. */
  roster: () => request<RosterDto>("/api/bots?includeHidden=true"),
  /** Alias : même payload, même URL: un seul cache HTTP. */
  get rosterIncludingHidden(): () => Promise<RosterDto> {
    return this.roster;
  },
  createBot: (input: CreateBotInput) =>
    request<BotDto>("/api/bots", { method: "POST", body: JSON.stringify(input) }),
  retryBotProfileProvision: (botId: string) =>
    request<BotDto>(`/api/bots/${botId}/profile-provision/retry`, { method: "POST", body: "{}" }),
  createBotProfile: (botId: string, displayName?: string) =>
    request<BotDto>(`/api/bots/${botId}/profile`, {
      method: "POST",
      body: JSON.stringify(displayName === undefined ? {} : { displayName }),
    }),
  botProfileStatus: (botId: string) =>
    request<BotProfileStatusDto>(`/api/bots/${botId}/profile/status`),
  repairBotProfile: (botId: string, mode: "transfer" | "reset", input: BotProfileRepairInput = {}) =>
    request<BotProfileRepairDto>(`/api/bots/${botId}/profile/${mode}`, { method: "POST", body: JSON.stringify(input) }),
  updateBot: (botId: string, input: UpdateBotInput) =>
    request<BotDto>(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Remet tous les bots au modèle global en base ; les profils hôte s'alignent ensuite (`botProfileModelSync`). */
  resetBotModelOverrides: () =>
    request<BotModelResetDto>("/api/bots/model-overrides/reset", { method: "POST" }),
  botProfileModelSync: () =>
    request<{ sync: BotProfileModelSyncDto | null }>("/api/bots/model-overrides/sync"),
  /**
   * Met le bot à la corbeille et programme le nettoyage du runtime. Les
   * données openedbot restent récupérables depuis les archives.
   */
  deleteBot: (botId: string) => request<BotDto>(`/api/bots/${botId}`, { method: "DELETE" }),
  purgeBot: (botId: string, options: { force?: boolean } = {}) =>
    request<BotPurgeResultDto>(
      `/api/bots/${botId}?purge=1${options.force ? "&force=1" : ""}`,
      { method: "DELETE" },
    ),
  retryBotHostCleanup: (botId: string) =>
    request<BotDto | undefined>(`/api/bots/${botId}/host-cleanup/retry`, { method: "POST", body: "{}" }),
};
