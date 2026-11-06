import { useEffect, useReducer, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { api, queryKeys } from "../../lib/api";
import { readCloudSession, subscribeCloudSession } from "../../lib/session/cloud-session";
import { useRunInProgress } from "../../lib/run/run-in-progress";
import { runsInProgress } from "./update-model";

/** Hors d'une conversation, ni flux ni barre ne tiennent le roster à jour : on le relit. */
const ROSTER_REFRESH_MS = 60_000;
/** Past two missed refreshes (failed, or paused offline), the cached count no longer says anything. */
export const RUNS_UNKNOWN_AFTER_MS = 2 * ROSTER_REFRESH_MS;

/**
 * Les runs en cours (`BotDto.running`, `GroupDto.running`, et le fil
 * ouvert), ou `null` quand on ne peut pas le dire : roster pas encore lu, ou
 * lu il y a plus de deux rafraîchissements (une minuterie fait expirer le
 * compte même quand la requête ne notifie plus rien). Le roster est relu toutes les minutes, fenêtre cachée comprise
 * (mode popup) : sur Réglages, aucun flux ne le patche. Sans session (page de
 * connexion), aucun run à attendre : zéro.
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
 * Le dialogue « Mise à jour prête » : ouvert par la pastille, la ligne du
 * menu du compte, Réglages ou le menu de l'app, avec la version que
 * l'utilisateur a vue. Un seul à la fois, monté par `DesktopUpdateLayer`.
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

/** Le code d'un refus de la coque (`NativeBridgeError`), ou `null`. */
export function refusalCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}
