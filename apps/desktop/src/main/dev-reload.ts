import { app } from "electron";
import { watch } from "node:fs";
import { log } from "./log";

/**
 * Running under `electron-vite dev` (make dev): the CLI sets this variable and
 * the Electron it spawns inherits it. Never true in a packaged app.
 */
export const isElectronViteDev = process.env.NODE_ENV_ELECTRON_VITE === "development" && !app.isPackaged;

const DEBOUNCE_MS = 200;

/**
 * electron-vite reloads renderers through its own Vite dev server, which this
 * app does not use (the UI is the remote console, the sign-in page a static
 * file). So in dev we reload the window ourselves when the rebuilt preload or
 * the sign-in page changes. Main process changes are electron-vite's job: it
 * restarts the app.
 */
export function reloadOnChange(directories: readonly string[], reload: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  for (const directory of directories) {
    try {
      watch(directory, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          log.info("dev: reloading the window");
          reload();
        }, DEBOUNCE_MS);
      });
    } catch (error) {
      log.warn(`dev: cannot watch ${directory} (${error instanceof Error ? error.message : "error"})`);
    }
  }
}
