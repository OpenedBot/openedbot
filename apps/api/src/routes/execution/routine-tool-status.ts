import type { BotRoutineToolDto, BotRoutineToolReason } from "@openedbot/contracts-api";
import { RELAY_FEATURE_PROFILE_CAPABILITIES } from "@openedbot/contracts-connector/features";
import type { RoutineToolBotState } from "@openedbot/execution/application/routine-tool-state";
import type { ApiConfig } from "../../infrastructure/config";

/** What the dialog says of `routine_manage` for one bot (0187): pure, shared by the installer and its routes. */

type Block = BotRoutineToolReason;
export type RoutineToolBotRow = RoutineToolBotState & { blockedReason: Block | null };

/** The reasons that do not go away by waiting: the host, the API or the bot's profile must change. */
const LASTING: ReadonlySet<Block> = new Set<Block>([
  "https_required", "runtime_required", "host_unsupported", "profile_unsupported", "profile_failed",
]);

export function routineToolUsesDevelopmentCallback(config: Pick<ApiConfig, "environment" | "publicUrl">): boolean {
  return config.environment === "development" && new URL(config.publicUrl).protocol === "http:";
}

/** The bot's profile exists and stays: not in a creation, not retired. */
export function profileReady(bot: RoutineToolBotRow): boolean {
  return !bot.retired && (bot.provision === null || bot.provision === "succeeded");
}

/**
 * The dialog's view of one bot, from its row and the host as read now.
 * Pure: the order of the rules is the contract.
 */
export function routineToolStatus(
  bot: RoutineToolBotRow,
  host: { block: Block | null; runtimeId: string | null; features: readonly string[] },
  now: Date,
): BotRoutineToolDto {
  const enabledHere = bot.enabledAt !== null && host.runtimeId !== null && bot.runtimeId === host.runtimeId;
  const profileBlock: Block | null = bot.provision === "failed" ? "profile_failed"
    : host.block === null && bot.profile !== null && !host.features.includes(RELAY_FEATURE_PROFILE_CAPABILITIES) ? "profile_unsupported"
      : null;
  const lasting = [host.block, profileBlock].find((reason): reason is Block => reason !== null && LASTING.has(reason)) ?? null;
  const base = { enabled: !bot.switchedOff, available: lasting === null, restartPending: false };
  if (bot.switchedOff) return { ...base, status: "switched_off", reason: null };
  // Installed and proven on the runtime it was proven on (unknown while the
  // link is down), on a profile that still stands: a host away takes nothing
  // back, the bot waits for it. A failed or retired profile says so first.
  const installed = profileReady(bot) && bot.enabledAt !== null && bot.runtimeId !== null && !bot.restartPendingSince
    && bot.readyAt !== null && bot.readyAt.getTime() <= now.getTime()
    && (host.runtimeId === null || bot.runtimeId === host.runtimeId);
  if (host.block === "host_offline" && installed) return { ...base, status: "active", reason: "host_offline" };
  if (enabledHere && bot.restartPendingSince) return { ...base, status: "restart_pending", reason: null, restartPending: true };
  if (enabledHere && bot.readyAt && bot.readyAt.getTime() <= now.getTime()) return { ...base, status: "active", reason: null };
  if (enabledHere) return { ...base, status: "pending", reason: null };
  if (lasting) return { ...base, status: "unavailable", reason: lasting };
  if (!profileReady(bot)) return { ...base, status: "pending", reason: "profile_preparing" };
  return { ...base, status: "pending", reason: host.block ?? bot.blockedReason };
}

/**
 * The host signal that warms the inventory also reconciles the routine
 * tool: one wiring point for the embedded broker and the separate gateway.
 */
export function withRoutineToolReconcile<W extends { warm(organizationId: string, runtimeId: string): void }>(
  warmer: W,
  installer: { schedule(organizationId: string): void },
): W {
  return {
    ...warmer,
    warm(organizationId: string, runtimeId: string) {
      warmer.warm(organizationId, runtimeId);
      installer.schedule(organizationId);
    },
  };
}
