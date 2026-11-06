import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { nativeUpdates, useNativeUpdateState } from "../../lib/platform/native-updates";
import { openUpdateDialog, useRunsInProgress } from "./update-hooks";
import { readyVersion } from "./update-model";
import { UpdateDialog } from "./update-dialog";

/** Où Réglages › Mises à jour se trouve (le menu de l'app et le notch l'ouvrent). */
export const UPDATES_SETTINGS_PATH = "/settings/updates";

/**
 * Ce que la console fait pour la mise à jour, une fois pour toute l'app :
 * dire à la coque combien de runs sont en cours (l'installation au repos
 * n'en attend aucun), répondre au menu de l'app (« Rechercher des mises à
 * jour… » ouvre les réglages, « Redémarrer pour mettre à jour » le dialogue),
 * et porter le dialogue. Monté dans la coque, au-dessus de l'écran « mise à
 * jour requise » : il reste là quand cet écran remplace l'app.
 */
export function DesktopUpdateLayer() {
  const runs = useRunsInProgress();
  const state = useNativeUpdateState();
  const navigate = useNavigate();
  // Lu au moment du choix dans le menu : l'écoute est posée une seule fois.
  const ready = useRef<string | null>(null);
  useEffect(() => {
    ready.current = readyVersion(state);
  }, [state]);

  useEffect(() => {
    void nativeUpdates()?.reportRuns(runs).catch(() => undefined);
  }, [runs]);

  useEffect(() => {
    const updates = nativeUpdates();
    if (!updates) return;
    return updates.onMenu((action) => {
      if (action === "install" && ready.current) openUpdateDialog(ready.current);
      else void navigate({ to: UPDATES_SETTINGS_PATH });
    });
  }, [navigate]);

  return <UpdateDialog />;
}
