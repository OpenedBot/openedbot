import { afterEach, beforeEach } from "bun:test";

/**
 * Runs the tests of the calling file as the desktop build of the console
 * (`VITE_OPENEDBOT_SHELL=tauri`): only there does `nativeBridge()` read the
 * bridge a test puts on `window.__OPENEDBOT_NATIVE__`. Vite replaces the
 * variable at build time; under `bun test`, `import.meta.env` is
 * `process.env`, read at each call. The constants computed when a module
 * loads (`DESKTOP_UPDATES`, the mount points of `desktop-update/entry.ts`)
 * keep their web value.
 */
export function asDesktopBuild(): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.VITE_OPENEDBOT_SHELL;
    process.env.VITE_OPENEDBOT_SHELL = "tauri";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.VITE_OPENEDBOT_SHELL;
    else process.env.VITE_OPENEDBOT_SHELL = previous;
  });
}
