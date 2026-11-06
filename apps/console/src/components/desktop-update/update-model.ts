import type { BotDto, GroupDto, RosterDto } from "@openedbot/contracts-api";
import type { NativeUpdatePhase, NativeUpdateState } from "../../lib/platform/native-updates";

/**
 * Ce que chaque surface montre d'un état de mise à jour, sans rien dessiner
 * (testé seul). Comme Grok Bot : rien tant qu'il n'y a rien à faire (au repos,
 * pendant la recherche, une version annoncée), un indicateur discret pendant
 * le téléchargement silencieux, la pastille bleue « Mettre à jour » une fois
 * prête. Une erreur ne s'affiche que dans Réglages › Mises à jour ; une mise à
 * jour requise remplace l'app par son écran, la pastille s'efface alors.
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

/** La ligne « Nouvelle mise à jour disponible » du menu du compte : la version prête, ou rien. */
export function menuRowVersion(state: NativeUpdateState | null): string | null {
  return state?.phase.status === "ready" ? state.phase.version : null;
}

/** La version prête, quelle que soit la surface. */
export function readyVersion(state: NativeUpdateState | null): string | null {
  return state?.phase.status === "ready" ? state.phase.version : null;
}

/**
 * Où en est la version que l'utilisateur a vue dans le dialogue : toujours la
 * même, remplacée par une plus récente (prête ou en téléchargement), ou
 * retirée. La coque refuse d'installer une version dépassée : le dialogue le
 * dit au lieu de proposer un redémarrage qui n'installerait rien.
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
 * Les runs en cours que la console connaît : chaque fil (bot ou salon) dont
 * le roster dit `running`, et au moins un si le fil ouvert en a un (le roster
 * peut avoir un temps de retard sur le flux du fil).
 */
export function runsInProgress(roster: RosterDto | undefined, openThreadRunning: boolean): number {
  const fromRoster = (roster?.bots.filter(liveBot).length ?? 0) + (roster?.groups?.filter(liveGroup).length ?? 0);
  return Math.max(fromRoster, openThreadRunning ? 1 : 0);
}
