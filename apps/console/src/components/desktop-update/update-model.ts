import type { BotDto, GroupDto, RosterDto } from "@openedbot/contracts-api";
import type { NativeUpdatePhase, NativeUpdateState } from "../../lib/platform/native-updates";

/**
 * What each surface shows of an update state, drawing nothing
 * (tested alone). Like the reference app: nothing while there is nothing to do (at rest,
 * during the search, a version announced), a discreet indicator during
 * the silent download, the blue « Mettre à jour » pill once
 * ready. An error shows only in Settings › Updates; a required
 * update replaces the app with its screen, and the pill then fades.
 */
export type PillView =
  | { kind: "hidden" }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string };

export function downloadPercent(phase: NativeUpdatePhase): number | null {
  if (phase.status !== "downloading" || !phase.total) return null;
  return Math.max(0, Math.min(100, Math.floor((phase.downloaded / phase.total) * 100)));
}

export function pillView(state: NativeUpdateState | null): PillView {
  if (!state || state.required) return { kind: "hidden" };
  const { phase } = state;
  if (phase.status === "downloading") return { kind: "downloading", version: phase.version, percent: downloadPercent(phase) };
  if (phase.status === "ready") return { kind: "ready", version: phase.version };
  return { kind: "hidden" };
}

/** The account menu's « Nouvelle mise à jour disponible » row: the ready version, or nothing. */
export function menuRowVersion(state: NativeUpdateState | null): string | null {
  return state?.phase.status === "ready" ? state.phase.version : null;
}

/** The ready version, whatever the surface. */
export function readyVersion(state: NativeUpdateState | null): string | null {
  return state?.phase.status === "ready" ? state.phase.version : null;
}

/**
 * Where the version the user saw in the dialog stands: still the
 * same, replaced by a newer one (ready or downloading), or
 * withdrawn. The shell refuses to install an outdated version: the dialog
 * says so instead of offering a restart that would install nothing.
 */
export type SeenVersion =
  | { kind: "same" }
  | { kind: "replaced"; version: string; ready: boolean; percent: number | null }
  | { kind: "gone" };

export function seenVersion(seen: string, state: NativeUpdateState | null): SeenVersion {
  const phase = state?.phase;
  if (!phase) return { kind: "same" };
  if (phase.status === "ready") return phase.version === seen ? { kind: "same" } : { kind: "replaced", version: phase.version, ready: true, percent: null };
  if (phase.status === "available" || phase.status === "downloading") {
    return phase.version === seen ? { kind: "same" } : { kind: "replaced", version: phase.version, ready: false, percent: downloadPercent(phase) };
  }
  if (phase.status === "installing") return { kind: "same" };
  return { kind: "gone" };
}

function liveBot(bot: BotDto): boolean {
  return bot.running === true && !bot.archivedAt && !bot.deletedAt;
}

function liveGroup(group: GroupDto): boolean {
  return group.running;
}

/**
 * The runs in progress the console knows: each thread (bot or group) whose
 * roster says `running`, and at least one if the open thread has one (the roster
 * can lag the thread's stream).
 */
export function runsInProgress(roster: RosterDto | undefined, openThreadRunning: boolean): number {
  const fromRoster = (roster?.bots.filter(liveBot).length ?? 0) + (roster?.groups?.filter(liveGroup).length ?? 0);
  return Math.max(fromRoster, openThreadRunning ? 1 : 0);
}
