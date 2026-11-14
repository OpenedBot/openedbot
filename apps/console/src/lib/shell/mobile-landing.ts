/**
 * Arrival on the mobile shell: which screen the app opens when it is launched.
 *
 * On a phone, a conversation app does not open a dashboard:
 * it opens a thread. As long as the roster is empty, `/` stays the overview (it
 * carries « + Nouveau bot »); as soon as there is a bot, arrival selects
 * the FIRST of the panel, the one the finger would touch anyway.
 *
 * "First" means first in the drawer column, not first in the
 * JSON array: `board-sidebar.tsx` shows pinned ones first, each
 * section sorted by decreasing activity. Two diverging definitions
 * would open a thread that is not the one at the top.
 */

import { partitionThreadVisibility } from "@/lib/thread/thread-visibility";
import type { BotDto } from "@openedbot/contracts-api";
import { isMobileShellPath } from "./mobile-navigation";

type RosterBot = Pick<BotDto, "id" | "pinned" | "lastActivityAt" | "archivedAt"> & { hidden?: boolean };

/**
 * The bot at the top of the panel, or `null` if the current roster is empty.
 *
 * Hidden and archived ones are left out: they are not in the column, so
 * opening them on arrival would land on a thread the panel does not show.
 */
export function firstRosterBotId(bots: readonly RosterBot[]): string | null {
  const current = partitionThreadVisibility(bots).visible.filter((bot) => bot.archivedAt == null);
  const ordered = [...current].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
  return ordered[0]?.id ?? null;
}

/**
 * The arrival latch: automatic selection happens ONLY ONCE per
 * app load.
 *
 * Without it, « Aperçu » (operator menu, panel logo) would become
 * unreachable on a phone: every return to `/` would send straight
 * back to the first bot. Arrival is an app launch, not an address.
 *
 * The entry path is read when the module loads, therefore before any
 * navigation: an app opened on a deep link (`/bot/…`, `/settings/…`)
 * has already spent its arrival, otherwise the first « Aperçu » tapped in the menu
 * would be swallowed by a selection that never happened. Screens outside the
 * shell (`/login`, `/onboarding`, `/legal`) do not spend it: the `/` that
 * follows a sign-in or the end of welcome IS the arrival in the app.
 */
let landingConsumed = typeof window !== "undefined"
  && window.location.pathname !== "/"
  && isMobileShellPath(window.location.pathname);

/** Tests only: replays the load entry. */
export function setMobileLandingEntry(pathname: string): void {
  landingConsumed = pathname !== "/" && isMobileShellPath(pathname);
}

/** True only once: the first visit to `/` of this load. */
export function consumeMobileLanding(): boolean {
  if (landingConsumed) return false;
  landingConsumed = true;
  return true;
}

/** Has arrival already played? A read with no side effect. */
export function isMobileLandingConsumed(): boolean {
  return landingConsumed;
}

/** Tests only: the latch lives at module scope. */
export function resetMobileLanding(): void {
  landingConsumed = false;
}
