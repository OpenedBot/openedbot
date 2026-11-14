import type { BotDto, BotModelResetDto, BotProfileModelSyncDto, BotProfileRepairDto, BotProfileRepairInput, BotProfileStatusDto, BotPurgeResultDto, RosterDto, UpdateBotInput } from "@openedbot/contracts-api";
import { request } from "./http";
import type { CreateBotInput } from "./types";

export const rosterApi = {
  /** Full roster: hidden ones travel too; the client partitions them. */
  roster: () => request<RosterDto>("/api/bots?includeHidden=true"),
  /** Alias: same payload, same URL: a single HTTP cache. */
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
  /** Puts every bot back on the global model in the database; host profiles align afterwards (`botProfileModelSync`). */
  resetBotModelOverrides: () =>
    request<BotModelResetDto>("/api/bots/model-overrides/reset", { method: "POST" }),
  botProfileModelSync: () =>
    request<{ sync: BotProfileModelSyncDto | null }>("/api/bots/model-overrides/sync"),
  /**
   * Moves the bot to the trash and schedules runtime cleanup. openedbot
   * data stays recoverable from the archives.
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
