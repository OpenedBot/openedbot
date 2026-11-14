import { watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const cwd = await realpath(process.cwd());
const args = process.argv.slice(2);
const entry = args.shift();

if (!entry) {
  throw new Error("Usage: bun scripts/dev-watch.ts <entry> [--root <dir>]...");
}

const customRoots: string[] = [];
while (args.length > 0) {
  const flag = args.shift();
  if (flag !== "--root") {
    throw new Error(`Unknown argument: ${flag}`);
  }
  const root = args.shift();
  if (!root) {
    throw new Error("--root requires a directory");
  }
  customRoots.push(root);
}

const repository = await realpath(path.resolve(cwd, "../.."));
const roots = customRoots.length > 0
  ? customRoots.map((root) => path.resolve(cwd, root))
  : [
      path.resolve(cwd, "src"),
      path.join(repository, "modules"),
      path.join(repository, "platform"),
      path.join(repository, "contracts"),
    ];

// The app the supervisor runs (apps/worker -> worker), named in its crash report.
const appName = path.basename(cwd);
const watchers: FSWatcher[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartTask: Promise<void> = Promise.resolve();
let lastChange = "unknown";
const moreChanges = new Set<string>();

function relevant(relativePath: string): boolean {
  const normalized = `/${relativePath.replaceAll(path.sep, "/")}/`;
  if (/\.(new|tmp|swp)$/.test(relativePath) || relativePath.endsWith("~") || path.basename(relativePath) === "4913") {
    return false;
  }
  if (/\/(node_modules|dist|tests)\//.test(normalized)) {
    return false;
  }
  if (/\.test\.tsx?$/.test(relativePath)) {
    return false;
  }
  return /\.(ts|tsx|json|sql)$/.test(relativePath);
}

// Children stopped on purpose (restart, shutdown): their exit is not a crash.
const stoppedOnPurpose = new WeakSet<object>();

function spawnChild() {
  return Bun.spawn(["bun", entry!], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
}

/**
 * Relays the child's stderr unchanged and keeps its last lines. Under
 * `make dev` a boot error scrolls away among the other apps' logs and the app
 * then stays down; the crash report repeats the error once the child is gone.
 */
async function relayStderr(stream: ReadableStream<Uint8Array>, tail: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  const keep = (line: string) => {
    tail.push(line);
    if (tail.length > 40) tail.shift();
  };
  for await (const chunk of stream) {
    process.stderr.write(chunk);
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(keep);
  }
  pending += decoder.decode();
  if (pending) keep(pending);
}

/** The line that names the failure: Bun's `error: ...`, else the last one. */
function failureLine(tail: readonly string[]): string {
  const lines = tail.map((line) => line.trim()).filter(Boolean);
  return lines.findLast((line) => /^(error|\w*Error)\b/.test(line)) ?? lines.at(-1) ?? "no error output";
}

function reportCrash(code: number, tail: readonly string[]): void {
  const red = process.env.NO_COLOR ? "" : "\x1b[1;31m";
  const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
  const rule = "=".repeat(72);
  process.stderr.write([
    `${red}${rule}`,
    `[dev-watch] ${appName.toUpperCase()} CRASHED (exit ${code}) and stays DOWN.`,
    `[dev-watch] ${failureLine(tail)}`,
    `[dev-watch] It restarts on the next source change; an env change needs make dev again.`,
    `${rule}${reset}`,
    "",
  ].join("\n"));
}

async function stopChild(signal: "SIGTERM" | "SIGINT"): Promise<number | undefined> {
  const current = child;
  if (!current) {
    return undefined;
  }
  stoppedOnPurpose.add(current);
  current.kill(signal);
  let timeout: number | ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    current.exited.then((code) => ({ code })),
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(resolve, 5_000);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  let code: number;
  if (result === undefined) {
    current.kill("SIGKILL");
    code = await current.exited;
  } else {
    code = result.code;
  }
  if (child === current) {
    child = undefined;
  }
  return code;
}

function scheduleRestart(relativePath: string): void {
  if (shuttingDown) {
    return;
  }
  if (lastChange !== relativePath) {
    moreChanges.add(relativePath);
  }
  lastChange = relativePath;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    const paths = [...moreChanges];
    moreChanges.clear();
    if (!paths.includes(lastChange)) {
      paths.push(lastChange);
    }
    const suffix = paths.length > 1 ? ` and ${paths.length - 1} more` : "";
    const reportPath = paths[0]!;
    process.stderr.write(`[dev-watch] restart: ${reportPath}${suffix}\n`);
    restartTask = restartTask.then(async () => {
      if (shuttingDown) {
        return;
      }
      await stopChild("SIGTERM");
      if (!shuttingDown) {
        startChild();
      }
    });
  }, 200);
}

function startChild(): void {
  const started = spawnChild();
  child = started;
  const tail: string[] = [];
  const relayed = relayStderr(started.stderr, tail);
  void started.exited.then(async (code) => {
    await relayed;
    if (shuttingDown || stoppedOnPurpose.has(started) || child !== started) return;
    child = undefined;
    if (code === 0) {
      process.stderr.write("[dev-watch] exited with code 0, waiting for a change\n");
    } else {
      reportCrash(code, tail);
    }
  });
}

for (const root of roots) {
  try {
    const canonicalRoot = await realpath(root);
    watchers.push(watch(canonicalRoot, { recursive: true }, (_event, filename) => {
      if (!filename) {
        return;
      }
      const changedPath = String(filename);
      if (relevant(changedPath)) {
        const rootRelative = path.relative(repository, path.join(canonicalRoot, changedPath));
        scheduleRestart(rootRelative);
      }
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`[dev-watch] warning: watch root does not exist: ${root}\n`);
    } else {
      throw error;
    }
  }
}

startChild();

await new Promise<void>((resolve) => {
  const shutdown = async (signal: "SIGTERM" | "SIGINT") => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    for (const watcher of watchers) {
      watcher.close();
    }
    await restartTask;
    const code = await stopChild(signal);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
    resolve();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  // Terminal fermé : l'enfant est arrêté proprement (SIGTERM), sinon l'API
  // meurt sans `stopped_at` et ses liens restent attribués à une instance morte.
  process.once("SIGHUP", () => void shutdown("SIGTERM"));
});
