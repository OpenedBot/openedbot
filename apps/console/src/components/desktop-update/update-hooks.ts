import { useEffect, useReducer, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { api, queryKeys } from "../../lib/api";
import { readCloudSession, subscribeCloudSession } from "../../lib/session/cloud-session";
import { useRunInProgress } from "../../lib/run/run-in-progress";
import { runsInProgress } from "./update-model";

/**
 * A hidden window (popup mode) holds no stream, and the shell's stream
 * patches the roster only while visible: the count of runs in progress is
 * reread, hidden window included.
 */
const ROSTER_REFRESH_MS = 60_000;
/** Past two missed refreshes (failed, or paused offline), the cached count no longer says anything. */
export const RUNS_UNKNOWN_AFTER_MS = 2 * ROSTER_REFRESH_MS;

/**
 * The runs in progress (`BotDto.running`, `GroupDto.running`, and the open
 * thread), or `null` when one cannot say: roster not read yet, or
 * read more than two refreshes ago (a timer expires the
 * count even when the request no longer notifies anything). The roster is reread every minute, hidden window included
 * (popup mode): hidden, no stream patches it. With no session (sign-in
 * page), no run to wait for: zero.
 */
export function useRunsInProgress(): number | null {
  const openThread = useRunInProgress((state) => state.running);
  const signedIn = useSyncExternalStore(subscribeCloudSession, () => readCloudSession()?.organizationId != null, () => false);
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: signedIn,
    refetchInterval: ROSTER_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  // A failed or paused refresh changes nothing the query reports: the expiry is timed here.
  const [, expire] = useReducer((tick: number) => tick + 1, 0);
  const updatedAt = roster.dataUpdatedAt;
  useEffect(() => {
    if (!signedIn || !updatedAt) return;
    const left = updatedAt + RUNS_UNKNOWN_AFTER_MS - Date.now();
    if (left < 0) return;
    const timer = setTimeout(expire, left + 1);
    return () => clearTimeout(timer);
  }, [signedIn, updatedAt]);
  if (!signedIn) return 0;
  const stale = Date.now() - updatedAt > RUNS_UNKNOWN_AFTER_MS;
  if (!roster.data || stale) return openThread ? 1 : null;
  return runsInProgress(roster.data, openThread);
}

/**
 * The « Mise à jour prête » dialog: opened by the pill, the account
 * menu row, Settings or the app menu, with the version the
 * user saw. One at a time, mounted by `DesktopUpdateLayer`.
 */
type UpdateDialogStore = {
  version: string | null;
  open: (version: string) => void;
  close: () => void;
};

export const useUpdateDialog = create<UpdateDialogStore>()((set) => ({
  version: null,
  open: (version) => set({ version }),
  close: () => set({ version: null }),
}));

export function openUpdateDialog(version: string): void {
  useUpdateDialog.getState().open(version);
}

/** The code of a refusal from the shell (`NativeBridgeError`), or `null`. */
export function refusalCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}
