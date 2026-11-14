#!/usr/bin/env bun
/**
 * The desktop app in dev mode, « openedbot dev » (app.openedbot.desktop.dev:
 * its own keychain entries and data, apart from the preview and the installed
 * app), against the local environment. `make desktop` runs it alone; `make dev`
 * runs it next to the API, the worker and the web console only with DESKTOP=1.
 *
 * `tauri dev` starts a Vite of the console in desktop mode
 * (`VITE_OPENEDBOT_SHELL=tauri`) on DESKTOP_DEV_PORT, beside the web one
 * (:1420), and the window loads it: hot reload of the console, the Rust shell
 * rebuilt and relaunched on every change under `src-tauri`. That Vite relays
 * `/api` to the local API, so the app talks to it as its own API, without
 * CORS. The shell accepts a `devUrl` only in a dev build, over http on
 * loopback (`window::use_dev_origin`).
 *
 * The session is kept in memory, not in the Keychain (see the env below):
 * no macOS password prompt on each launch.
 *
 * Without cargo the desktop is skipped with a message rather than failing:
 * `DESKTOP=1 make dev` keeps serving the web console on a machine without Rust.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dir, "..");
const CONSOLE_DIR = path.resolve(APP_DIR, "../console");

/** The `--config` overlay of the dev build, merged over `tauri.conf.json`. */
export function devConfig(port: number, consoleDir: string, identifier = "app.openedbot.desktop.dev") {
  const origin = `http://localhost:${port}`;
  return {
    identifier,
    productName: "openedbot dev",
    build: {
      devUrl: origin,
      beforeDevCommand: {
        script: `VITE_OPENEDBOT_SHELL=tauri OPENEDBOT_CONSOLE_PLUGINS= ./node_modules/.bin/vite --port ${port} --strictPort`,
        cwd: consoleDir,
        wait: false,
      },
    },
  };
}

export function devPort(raw: string | undefined): number {
  const port = Number(raw ?? "1422");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DESKTOP_DEV_PORT invalide : ${raw}`);
  }
  return port;
}

function main() {
  if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error("cargo introuvable : l'app desktop n'est pas lancée (installer Rust via rustup, ou lancer make dev sans DESKTOP=1).");
    return;
  }
  const port = devPort(process.env.DESKTOP_DEV_PORT);
  const webConsole = process.env.WEB_APP_URL || "http://localhost:1420";
  const child = spawn(
    path.join(APP_DIR, "node_modules/.bin/tauri"),
    ["dev", "--config", JSON.stringify(devConfig(port, CONSOLE_DIR, process.env.OPENEDBOT_DESKTOP_TEST_IDENTIFIER)), ...(process.env.OPENEDBOT_DESKTOP_MCP === "1" ? ["--features", "desktop-mcp"] : [])],
    {
      cwd: APP_DIR,
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        OPENEDBOT_API_ORIGIN: `http://localhost:${port}`,
        OPENEDBOT_PUBLIC_CONSOLE_URL: webConsole,
        // The debug binary is ad-hoc signed and its signature changes with
        // every Rust rebuild, so the Keychain never recognises it and asks for
        // the login password each time. The dev session stays in memory: it
        // survives console hot reloads, not a Rust rebuild.
        // OPENEDBOT_PREVIEW_VAULT=keychain brings the Keychain back.
        OPENEDBOT_PREVIEW_VAULT: process.env.OPENEDBOT_PREVIEW_VAULT || "memory",
      },
    },
  );
  // `tauri dev` runs in its own process group with its Vite and the app: on
  // SIGTERM (`make stop` targets this launcher only) the tauri CLI exits
  // without stopping them, which left both orphaned and :1422 taken. The
  // signal goes to the whole group instead; Ctrl-C reaches it the same way,
  // the group being out of the terminal's foreground group.
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // ESRCH: nothing left in the group.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => signalGroup(signal));
  }
  child.on("error", (error) => {
    console.error(`tauri dev n'a pas démarré : ${error.message}`);
    process.exit(1);
  });
  // The tauri CLI can die first (`make stop` matches it by its directory too):
  // sweep what it leaves in its group before exiting.
  child.on("exit", (code, signal) => {
    signalGroup("SIGTERM");
    process.exit(code ?? (signal ? 0 : 1));
  });
}

if (import.meta.main) main();
