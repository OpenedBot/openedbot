import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { nativeUpdates, useNativeUpdateState } from "../../lib/platform/native-updates";
import { openUpdateDialog, useRunsInProgress } from "./update-hooks";
import { readyVersion } from "./update-model";
import { UpdateDialog } from "./update-dialog";

/** Where Settings › Updates is (the app menu and the notch open it). */
export const UPDATES_SETTINGS_PATH = "/settings/updates";

/**
 * What the console does for the update, once for the whole app:
 * tell the shell how many runs are in progress (an install at rest
 * waits for none), answer the app menu (« Rechercher des mises à
 * jour… » opens settings, « Redémarrer pour mettre à jour » the dialog),
 * and carry the dialog. Mounted in the shell, above the « mise à
 * jour requise » screen: it stays there when that screen replaces the app.
 */
export function DesktopUpdateLayer() {
  const runs = useRunsInProgress();
  const state = useNativeUpdateState();
  const navigate = useNavigate();
  // Read at the moment of the choice in the menu: the listener is set once only.
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
