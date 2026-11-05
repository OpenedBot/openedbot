// `bun dev` (and its dev:prod variant): electron-vite dev, plus,
// on the operator's Windows machine only, the two-way sync with the dev PC
// (../openedbot-windows/sync.mjs, CLAUDE.md "Working from Windows").
//
// The sync runs if and only if this dev app runs: it is a child of this
// script, started before electron-vite and killed when electron-vite exits.
// It used to be started on its own by start-openedbot.ps1 and outlived the app;
// when the dev PC dropped off the network it died, and nothing restarted it.
// Elsewhere (the dev PC, a Mac, no openedbot-windows folder) this is plain
// `electron-vite dev --watch`.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const toolsDir = path.resolve(root, "..", "openedbot-windows");
const syncScript = path.join(toolsDir, "sync.mjs");
const lockFile = path.join(toolsDir, "sync.lock");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The PID of a sync that is already running (another `bun dev`), if any.
function runningSync(): number | null {
  if (!existsSync(lockFile)) return null;
  const pid = Number(readFileSync(lockFile, "utf8"));
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}

async function startSync(): Promise<Bun.Subprocess | null> {
  if (process.platform !== "win32" || !existsSync(syncScript)) return null;
  const other = runningSync();
  if (other) {
    console.log(`[sync] already running (PID ${other}), not starting another one`);
    return null;
  }
  // One pass first, in the foreground: a conflict must stop the launch
  // (status.json lists it) rather than run the app on two diverging copies.
  const once = Bun.spawn(["node", syncScript], { cwd: toolsDir, stdout: "ignore", stderr: "inherit" });
  const code = await once.exited;
  if (code === 2) {
    console.error(`[sync] conflicts between Windows and the dev PC: resolve them first, see ${path.join(toolsDir, "status.json")}`);
    process.exit(1);
  }
  // Any other failure (dev PC unreachable): the watcher retries every 4 s.
  if (code !== 0) console.warn("[sync] first pass failed, the watcher keeps retrying (status.json)");
  const watcher = Bun.spawn(["node", syncScript, "--watch"], {
    cwd: toolsDir,
    stdout: Bun.file(path.join(toolsDir, "sync.log")),
    stderr: Bun.file(path.join(toolsDir, "sync-errors.log")),
    windowsHide: true,
  });
  console.log(`[sync] watching (PID ${watcher.pid}), stops with the app`);
  return watcher;
}

function stopSync(watcher: Bun.Subprocess | null): void {
  if (!watcher || watcher.exitCode !== null) return;
  watcher.kill();
  // A killed process never runs its exit handler: drop the lock it left.
  try {
    if (readFileSync(lockFile, "utf8") === String(watcher.pid)) rmSync(lockFile);
  } catch {}
}

const watcher = await startSync();
const app = Bun.spawn([process.execPath, "x", "electron-vite", "dev", "--watch", "--ignoreConfigWarning"], {
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.kill(signal);
    stopSync(watcher);
  });
}
const code = await app.exited;
stopSync(watcher);
process.exit(code);
