// D0 baseline (docs/architecture/0001-refonte-tauri-et-produit.md, section 3):
// measures G1 (time to a usable thread list), G2 (JS/CSS loaded at open),
// G3 (memory at rest) and G4 (streaming smoothness) on the web console and on
// the current Electron shell, against the LOCAL dev API. Rerunnable; writes
// tmp/perf/d0-<timestamp>.json.
//
//   bun apps/console/scripts/perf/d0-baseline.ts --env-file <path to .env.local> [--runs 5]
//     [--stream-runs 2] [--only web|electron] [--skip-stream] [--skip-g2]
//     [--skip-memory]
//
// Needs: the dev API on :8790 and Mailpit on :8025 (`make dev`), a runtime
// linked to the E2E account's org (lab VM 240) for G4, and `bun install` in
// the repo root and in apps/desktop. The password is read from the env file
// inside this process only (lib/session.ts, next to this file).
//
// What the numbers mean:
//   - "usable thread list" = the first sidebar link to a bot's thread
//     (`a[href*="/bot/"]`) is attached and visible. One bot = one thread.
//   - G1 cases, per trial, on one profile:
//       first  = signed in, every cache empty (fresh profile + session only);
//       next   = same profile relaunched (HTTP cache and query cache warm);
//       update = same profile, same origin, after a NEW build (other chunk
//                names, other build id: the persisted query cache is dropped).
//     Wall clock from process spawn to the marker, so browser/Electron start
//     is included; for the web, the in-page time from navigation start too.
//   - The console is a production build served like production (gzip, ETag,
//     no Cache-Control: lib/static-server.ts), solo variant (no
//     pro console plugins).
//   - Electron runs the compiled shell (`electron-vite build`) with a throwaway
//     home (CFFIXED_USER_HOME) and Chromium's mock keychain, so it never
//     touches the developer's own app profile or Keychain.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { e2eEmail, readMailpitCode, signInWeb, signOutWeb, type WebSession } from "./lib/session";
import { chromiumPidFor, processTreeRssKb } from "./lib/process-memory";
import { measureStreaming, openBotThread } from "./lib/streaming";
import { LOCAL, startStaticServer, type NetworkProfile, type StaticServer } from "./lib/static-server";

const REPO = resolve(import.meta.dir, "../../../..");
const CONSOLE_DIR = join(REPO, "apps/console");
const DESKTOP_DIR = join(REPO, "apps/desktop");
const ELECTRON_BIN = join(DESKTOP_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const MARKER = 'a[href*="/bot/"]';

const { values: args } = parseArgs({
  options: {
    "env-file": { type: "string" },
    runs: { type: "string", default: "5" },
    "stream-runs": { type: "string", default: "2" },
    only: { type: "string" },
    "skip-stream": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    "skip-g2": { type: "boolean", default: false },
    "skip-memory": { type: "boolean", default: false },
    bot: { type: "string", default: "Atlas" },
    "wan-rtt": { type: "string", default: "50" },
    "wan-mbps": { type: "string", default: "50" },
    port: { type: "string", default: "4180" },
    api: { type: "string", default: "http://127.0.0.1:8790" },
  },
});
const ENV_FILE = resolve(args["env-file"] ?? join(REPO, ".env.local"));
const RUNS = Number(args.runs);
const STREAM_RUNS = Number(args["stream-runs"]);
const OUT_DIR = join(REPO, "tmp/perf");
const WAN: NetworkProfile = { name: "wan", rttMs: Number(args["wan-rtt"]), mbps: Number(args["wan-mbps"]) };
const NETWORKS: NetworkProfile[] = [LOCAL, WAN];
const STAMP = new Date().toISOString().replace(/[:.]/gu, "-");
const WORK = join(OUT_DIR, `d0-${STAMP}`);
mkdirSync(WORK, { recursive: true });

const log = (...parts: unknown[]) => console.log(`[d0 ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function build(outDir: string, nonce: string): string {
  const result = Bun.spawnSync(["./node_modules/.bin/vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: CONSOLE_DIR,
    // A VITE_ variable is part of the build id (vite-build-id.ts), so build B
    // gets another id and another entry chunk name, as a new deploy would.
    env: { ...process.env, VITE_D0_BUILD_NONCE: nonce, OPENEDBOT_CONSOLE_PLUGINS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`vite build failed:\n${result.stderr.toString()}`);
  return /assets\/(index-[^"]+\.js)/u.exec(readFileSync(join(outDir, "index.html"), "utf8"))?.[1] ?? "?";
}

// ---------------------------------------------------------------------------
// In-page probes
// ---------------------------------------------------------------------------

/** Installed before the console runs: when the marker first appears (navigation-relative). */
const MARKER_INIT = `(() => {
  const selector = ${JSON.stringify(MARKER)};
  const check = () => {
    if (window.__d0MarkerAt) return true;
    const node = document.querySelector(selector);
    if (node && node.getClientRects().length > 0) {
      window.__d0MarkerAt = performance.now();
      window.__d0MarkerEpoch = performance.timeOrigin + window.__d0MarkerAt;
      return true;
    }
    return false;
  };
  const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
  const start = () => { if (!check()) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); };
  if (document.documentElement) start(); else document.addEventListener("readystatechange", start, { once: true });
})();`;

/** The entry chunk the page actually runs: the identity of the build it loaded. */
async function loadedEntry(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const src = [...document.querySelectorAll<HTMLScriptElement>("script[type=module][src]")].map((s) => s.src).find((s) => /\/assets\/index-[^/]+\.js$/u.test(s));
    return src ? src.slice(src.lastIndexOf("/") + 1) : null;
  });
}

/** Electron cannot get an init script before its first page: poll over CDP instead. */
async function waitForMarkerEpoch(page: Page, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      return Boolean(node && node.getClientRects().length > 0);
    }, MARKER).catch(() => false);
    if (visible) return Date.now();
    await Bun.sleep(10);
  }
  throw new Error(`marker ${MARKER} not visible after ${timeoutMs} ms (${page.url()})`);
}

// Every launch opens the console's event stream, and the API allows 30
// `GET /api/events*` a minute per client (platform/config/src/rate-limit.ts),
// shared with any dev console running on the same machine. Launches are
// spaced so this script stays near 15 a minute and never starves it.
const LAUNCH_SPACING_MS = 4_000;
let lastLaunchAt = 0;
async function paceLaunch(): Promise<void> {
  const wait = lastLaunchAt + LAUNCH_SPACING_MS - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastLaunchAt = Date.now();
}

/** A failed trial is kept as a failure with its evidence, never retried silently. */
async function recordFailure(label: string, page: Page | null, error: unknown): Promise<{ label: string; error: string; url: string | null; screenshot: string | null }> {
  const dir = join(OUT_DIR, `d0-${STAMP}-failures`);
  mkdirSync(dir, { recursive: true });
  let screenshot: string | null = null;
  if (page) {
    screenshot = join(dir, `${label}.png`);
    await page.screenshot({ path: screenshot }).catch(() => (screenshot = null));
  }
  const failure = { label, error: error instanceof Error ? error.message.split("\n")[0]! : String(error), url: page?.url() ?? null, screenshot };
  log("FAILED", JSON.stringify(failure));
  return failure;
}

// ---------------------------------------------------------------------------
// Web (Chromium)
// ---------------------------------------------------------------------------

async function webContext(profileDir: string, session: WebSession, headless = true): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless,
    viewport: { width: 1280, height: 820 },
    locale: "fr-FR",
  });
  await context.addCookies(session.cookies);
  await context.addInitScript(`(() => {
    try {
      if (!localStorage.getItem("openedbot:cloud-session")) {
        localStorage.setItem("openedbot:cloud-session", ${JSON.stringify(JSON.stringify(session.cloudSession))});
      }
    } catch {}
  })();`);
  await context.addInitScript(MARKER_INIT);
  return context;
}

async function webLaunch(profileDir: string, server: StaticServer, session: WebSession) {
  await paceLaunch();
  const spawnedAt = Date.now();
  const context = await webContext(profileDir, session);
  const page = context.pages()[0] ?? await context.newPage();
  const apiErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/")) apiErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  try {
    await page.goto(`${server.origin}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => Boolean((window as unknown as { __d0MarkerAt?: number }).__d0MarkerAt), undefined, { timeout: 60_000, polling: 50 });
  } catch (error) {
    const failure = await recordFailure(`web-${Date.now()}`, page, error);
    await context.close();
    throw Object.assign(new Error(`${failure.error} (API errors: ${apiErrors.slice(0, 8).join(", ") || "none"})`), { failure });
  }
  const { markerAt, markerEpoch } = await page.evaluate(() => {
    const w = window as unknown as { __d0MarkerAt: number; __d0MarkerEpoch: number };
    return { markerAt: w.__d0MarkerAt, markerEpoch: w.__d0MarkerEpoch };
  });
  return { context, page, wallMs: Math.round(markerEpoch - spawnedAt), navigationMs: Math.round(markerAt), entry: await loadedEntry(page) };
}

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------

type ElectronRun = { proc: Bun.Subprocess; browser: Browser; page: Page; spawnedAt: number };

async function electronLaunch(home: string, server: StaticServer, port: number): Promise<ElectronRun> {
  await paceLaunch();
  const spawnedAt = Date.now();
  const proc = Bun.spawn([ELECTRON_BIN, DESKTOP_DIR, `--remote-debugging-port=${port}`, "--use-mock-keychain"], {
    env: {
      ...process.env,
      OPENEDBOT_CONSOLE_URL: server.origin,
      OPENEDBOT_API_ORIGIN: server.origin,
      CFFIXED_USER_HOME: home,
    },
    stdout: "ignore",
    stderr: Bun.file(join(home, "electron.log")),
  });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 60_000;
    while (!browser && Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
      } catch {
        await Bun.sleep(20);
      }
    }
    if (!browser) throw new Error("Electron CDP endpoint never answered");
    let page: Page | null = null;
    while (!page && Date.now() < deadline) {
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith(server.origin)) ?? null;
      if (!page) await Bun.sleep(10);
    }
    if (!page) throw new Error("Electron window never loaded the console");
    return { proc, browser, page, spawnedAt };
  } catch (error) {
    // No ElectronRun reaches the caller: stop what was started here.
    await stopElectron(proc, browser);
    throw error;
  }
}

async function stopElectron(proc: Bun.Subprocess, browser: Browser | null): Promise<void> {
  await browser?.close().catch(() => undefined);
  proc.kill("SIGTERM");
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
  if (!exited) proc.kill("SIGKILL");
  await proc.exited;
  await Bun.sleep(300);
}

async function electronQuit(run: ElectronRun): Promise<void> {
  await stopElectron(run.proc, run.browser);
}

/** Native e-mail-code sign-in through the shell's own bridge, the way the console's /login does it. */
async function electronSignIn(run: ElectronRun, email: string): Promise<void> {
  await run.page.waitForFunction(() => Boolean((window as unknown as { __OPENEDBOT_NATIVE__?: { auth?: unknown } }).__OPENEDBOT_NATIVE__?.auth), undefined, { timeout: 30_000 });
  const since = Date.now();
  await run.page.evaluate((address) => (window as unknown as { __OPENEDBOT_NATIVE__: { auth: { requestEmailCode(e: string, l: string): Promise<unknown> } } }).__OPENEDBOT_NATIVE__.auth.requestEmailCode(address, "fr"), email);
  const code = await readMailpitCode(email, since);
  await run.page.evaluate(([address, value]) => (window as unknown as { __OPENEDBOT_NATIVE__: { auth: { verifyEmailCode(e: string, c: string): Promise<unknown> } } }).__OPENEDBOT_NATIVE__.auth.verifyEmailCode(address!, value!), [email, code]);
}

/** Keep the session (token file, config) and drop every cache: a signed-in first launch. */
function electronDropCaches(home: string): void {
  const userData = join(home, "Library/Application Support/openedbot");
  for (const entry of readdirSync(userData)) {
    if (/^tokens|token|config\.json$|preferences|window-state/iu.test(entry)) continue;
    rmSync(join(userData, entry), { recursive: true, force: true });
  }
  rmSync(join(home, "Library/Caches"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G2: what the browser fetches to open the console
// ---------------------------------------------------------------------------

async function measureOpenBytes(server: StaticServer, buildDir: string, session: WebSession) {
  const profile = join(WORK, "g2-profile");
  const context = await webContext(profile, session);
  const page = context.pages()[0] ?? await context.newPage();
  let loaded: Array<{ path: string; type: string; atMarker: boolean }> = [];
  try {
    await page.goto(`${server.origin}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => Boolean((window as unknown as { __d0MarkerAt?: number }).__d0MarkerAt), undefined, { timeout: 60_000, polling: 50 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await Bun.sleep(2_000);
    // Resource Timing against the page's own marker time: a file belongs to
    // "until the marker" when it finished before the marker appeared, whatever
    // the polling interval of this script.
    loaded = await page.evaluate((origin) => {
      const markerAt = (window as unknown as { __d0MarkerAt: number }).__d0MarkerAt;
      return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((entry) => entry.name.startsWith(origin))
        .map((entry) => {
          const path = new URL(entry.name).pathname;
          const type = /\.css$/u.test(path) ? "stylesheet" : /\.m?js$/u.test(path) ? "script" : "other";
          return { path, type, atMarker: entry.responseEnd <= markerAt };
        })
        .filter((entry) => entry.type !== "other");
    }, server.origin);
  } finally {
    await context.close().catch(() => undefined);
  }
  const sizes = (subset: typeof loaded, type: string) => {
    let raw = 0;
    let gzip = 0;
    let brotli = 0;
    let files = 0;
    for (const entry of subset.filter((item) => item.type === type)) {
      const file = join(buildDir, entry.path);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      files += 1;
      raw += bytes.length;
      gzip += gzipSync(bytes, { level: 9 }).length;
      brotli += brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    }
    return { files, rawKb: Math.round(raw / 1024), gzipKb: Math.round(gzip / 1024), brotliKb: Math.round(brotli / 1024) };
  };
  const atMarker = loaded.filter((entry) => entry.atMarker);
  const entry = /assets\/(index-[^"]+\.js)/u.exec(readFileSync(join(buildDir, "index.html"), "utf8"))?.[1];
  const entryBytes = entry ? readFileSync(join(buildDir, "assets", entry)) : null;
  return {
    entryChunk: entry
      ? { file: entry, rawKb: Math.round(entryBytes!.length / 1024), gzipKb: Math.round(gzipSync(entryBytes!, { level: 9 }).length / 1024) }
      : null,
    untilMarker: { js: sizes(atMarker, "script"), css: sizes(atMarker, "stylesheet") },
    untilIdle: { js: sizes(loaded, "script"), css: sizes(loaded, "stylesheet") },
    files: [...new Set(loaded.map((item) => item.path))].sort(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const only = args.only;
  const results: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    machine: Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.toString().trim(),
    memoryGb: Math.round(Number(Bun.spawnSync(["sysctl", "-n", "hw.memsize"]).stdout.toString()) / 1024 ** 3),
    os: `macOS ${Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim()}`,
    gitHead: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO }).stdout.toString().trim(),
    marker: MARKER,
    runs: RUNS,
    networks: NETWORKS,
  };

  const buildA = join(WORK, "build-a");
  const buildB = join(WORK, "build-b");
  if (args["no-build"]) throw new Error("--no-build is not supported yet: the update case needs two builds");
  log("building the console twice (A, then B with another build id)");
  const entryA = build(buildA, "a");
  const entryB = build(buildB, "b");
  if (entryA === entryB) throw new Error(`builds A and B share their entry chunk (${entryA}): the update case would be a no-op`);
  results.builds = { a: entryA, b: entryB };

  const server = startStaticServer({ root: buildA, port: Number(args.port), apiTarget: args.api! });
  const consoleHost = new URL(server.origin).hostname;
  const session = await signInWeb(args.api!, consoleHost, ENV_FILE);

  const failures: Array<{ trial: string; error: string }> = [];
  const wrongBuild: Array<{ trial: string; expected: string; loaded: string | null }> = [];
  results.failures = failures;
  results.wrongBuild = wrongBuild;
  try {
    const raw = await (await fetch(`${args.api}/api/bots`, { headers: { cookie: session.cookieHeader } })).json() as
      Array<{ id: string; name: string; threadId: string }> | { bots: Array<{ id: string; name: string; threadId: string }> };
    const bots = Array.isArray(raw) ? raw : raw.bots;
    const bot = bots.find((candidate) => candidate.name === args.bot);
    if (!bot) throw new Error(`no bot named ${args.bot} in the E2E account (${bots.map((b) => b.name).join(", ")})`);
    results.bot = bot.name;

    if (!args["skip-g2"]) {
      log("G2: bytes loaded at open");
      results.g2 = await measureOpenBytes(server, buildA, session);
      log("G2", JSON.stringify((results.g2 as { untilMarker: unknown }).untilMarker));
    }

    if (!only || only === "web") {
      const web: Record<string, number[]> = {};
      for (const network of NETWORKS) {
        server.setNetwork(network);
        for (let run = 0; run < RUNS; run++) {
          const profile = join(WORK, `web-profile-${network.name}-${run}`);
          for (const [name, root, expected] of [["first", buildA, entryA], ["next", buildA, entryA], ["update", buildB, entryB]] as const) {
            server.setRoot(root);
            let launched: Awaited<ReturnType<typeof webLaunch>> | null = null;
            try {
              launched = await webLaunch(profile, server, session);
              if (launched.entry !== expected) {
                // Measured on the wrong build: rejected, never averaged in.
                wrongBuild.push({ trial: `web ${network.name} ${name} run ${run + 1}`, expected, loaded: launched.entry });
                (web[`${network.name}.${name}Wall`] ??= []).push(Number.NaN);
                (web[`${network.name}.${name}Nav`] ??= []).push(Number.NaN);
              } else {
                (web[`${network.name}.${name}Wall`] ??= []).push(launched.wallMs);
                (web[`${network.name}.${name}Nav`] ??= []).push(launched.navigationMs);
              }
            } catch (error) {
              failures.push({ trial: `web ${network.name} ${name} run ${run + 1}`, error: error instanceof Error ? error.message : String(error) });
              (web[`${network.name}.${name}Wall`] ??= []).push(Number.NaN);
            } finally {
              await launched?.context.close().catch(() => undefined);
            }
          }
          log(`G1 web ${network.name} run ${run + 1}/${RUNS}`, web[`${network.name}.firstWall`]!.at(-1), web[`${network.name}.nextWall`]!.at(-1), web[`${network.name}.updateWall`]!.at(-1));
        }
      }
      server.setNetwork(LOCAL);
      server.setRoot(buildA);
      const memory: number[] = [];
      for (let run = 0; run < (args["skip-memory"] ? 0 : Math.min(3, RUNS)); run++) {
        const profile = join(WORK, `web-profile-local-${run}`);
        let launched: Awaited<ReturnType<typeof webLaunch>> | null = null;
        try {
          launched = await webLaunch(profile, server, session);
          await openBotThread(launched.page, bot.id);
          await Bun.sleep(30_000);
          const pid = chromiumPidFor(profile);
          if (pid) memory.push(processTreeRssKb(pid).rssKb);
        } catch (error) {
          failures.push({ trial: `web memory run ${run + 1}`, error: error instanceof Error ? error.message : String(error) });
        } finally {
          await launched?.context.close().catch(() => undefined);
        }
      }
      const stream: unknown[] = [];
      if (!args["skip-stream"]) {
        for (let run = 0; run < STREAM_RUNS; run++) {
          let launched: Awaited<ReturnType<typeof webLaunch>> | null = null;
          try {
            launched = await webLaunch(join(WORK, "web-profile-local-0"), server, session);
            await openBotThread(launched.page, bot.id);
            const measured = await measureStreaming(launched.page, { base: args.api!, cookie: session.cookieHeader, threadId: bot.threadId });
            log(`G4 web run ${run + 1}`, JSON.stringify(measured));
            stream.push(measured);
          } catch (error) {
            failures.push({ trial: `web stream run ${run + 1}`, error: error instanceof Error ? error.message : String(error) });
          } finally {
            await launched?.context.close().catch(() => undefined);
          }
        }
      }
      results.web = {
        engine: `Chromium ${chromium.name()} (Playwright, headless new mode)`,
        g1: Object.fromEntries(Object.entries(web).map(([key, values]) => [key, { median: median(values), values }])),
        g3: { medianMb: memory.length ? Math.round(median(memory)! / 1024) : null, valuesKb: memory, note: "headless Chromium, indicative only" },
        g4: stream,
      };
    }

    if (!only || only === "electron") {
      const electron: Record<string, number[]> = {};
      const memory: Array<{ rssKb: number; processes: number }> = [];
      const stream: unknown[] = [];
      const email = e2eEmail(ENV_FILE);
      // A signed-in profile kept for the streaming trials, which run after G1.
      let streamHome: string | null = null;
      for (let run = 0; run < RUNS; run++) {
        const home = join(WORK, `electron-home-${run}`);
        mkdirSync(home, { recursive: true });
        const port = 9470 + run;
        server.setRoot(buildA);
        // Sign in once (not measured), then drop every cache but the session.
        try {
          const signIn = await electronLaunch(home, server, port);
          try {
            await electronSignIn(signIn, email);
            await waitForMarkerEpoch(signIn.page);
            await Bun.sleep(1_000);
          } finally {
            await electronQuit(signIn);
          }
        } catch (error) {
          failures.push({ trial: `electron sign-in run ${run + 1}`, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        streamHome ??= home;
        electronDropCaches(home);
        for (const network of NETWORKS) {
          server.setNetwork(network);
          if (network !== NETWORKS[0]) electronDropCaches(home);
          for (const [name, root, expected] of [["first", buildA, entryA], ["next", buildA, entryA], ["update", buildB, entryB]] as const) {
            server.setRoot(root);
            const key = `${network.name}.${name}`;
            let launched: ElectronRun | null = null;
            try {
              launched = await electronLaunch(home, server, port);
              const markerAt = await waitForMarkerEpoch(launched.page);
              const entry = await loadedEntry(launched.page).catch(() => null);
              if (entry !== expected) {
                wrongBuild.push({ trial: `electron ${key} run ${run + 1}`, expected, loaded: entry });
                (electron[key] ??= []).push(Number.NaN);
              } else {
                (electron[key] ??= []).push(markerAt - launched.spawnedAt);
              }
              // Memory: three samples at most, on a warm local launch.
              if (network === LOCAL && name === "next" && run < 3 && !args["skip-memory"]) {
                await openBotThread(launched.page, bot.id);
                await Bun.sleep(30_000);
                memory.push(processTreeRssKb(launched.proc.pid));
              }
            } catch (error) {
              const failure = await recordFailure(`electron-${network.name}-${name}-${run + 1}`, launched?.page ?? null, error);
              failures.push({ trial: `electron ${key} run ${run + 1}`, error: failure.error });
              if ((electron[key] ??= []).length < run + 1) electron[key]!.push(Number.NaN);
            } finally {
              if (launched) await electronQuit(launched);
            }
          }
          log(`G1 electron ${network.name} run ${run + 1}/${RUNS}`, electron[`${network.name}.first`]?.at(-1), electron[`${network.name}.next`]?.at(-1), electron[`${network.name}.update`]?.at(-1));
        }
        server.setNetwork(LOCAL);
      }
      // Streaming, scheduled on its own so --stream-runs is honoured whatever --runs is.
      server.setRoot(buildA);
      for (let run = 0; run < (args["skip-stream"] ? 0 : STREAM_RUNS); run++) {
        if (!streamHome) {
          failures.push({ trial: `electron stream run ${run + 1}`, error: "no signed-in Electron profile" });
          continue;
        }
        let launched: ElectronRun | null = null;
        try {
          launched = await electronLaunch(streamHome, server, 9490);
          await waitForMarkerEpoch(launched.page);
          await openBotThread(launched.page, bot.id);
          const measured = await measureStreaming(launched.page, { base: args.api!, cookie: session.cookieHeader, threadId: bot.threadId });
          log(`G4 electron run ${run + 1}`, JSON.stringify(measured));
          stream.push(measured);
        } catch (error) {
          const failure = await recordFailure(`electron-stream-${run + 1}`, launched?.page ?? null, error);
          failures.push({ trial: `electron stream run ${run + 1}`, error: failure.error });
        } finally {
          if (launched) await electronQuit(launched);
        }
      }
      results.electron = {
        engine: `Electron ${JSON.parse(readFileSync(join(DESKTOP_DIR, "node_modules/electron/package.json"), "utf8")).version}`,
        g1: Object.fromEntries(Object.entries(electron).map(([key, values]) => [key, { median: median(values), values }])),
        g3: { medianMb: memory.length ? Math.round(median(memory.map((m) => m.rssKb))! / 1024) : null, samples: memory },
        g4: stream,
      };
    }
  } finally {
    await signOutWeb(args.api!, session).catch(() => undefined);
    server.stop();
  }

  results.finishedAt = new Date().toISOString();
  const file = join(OUT_DIR, `d0-${STAMP}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  log("written", file);
  // Profiles and builds are throwaway; the JSON is the result.
  for (const entry of readdirSync(WORK)) {
    const path = join(WORK, entry);
    if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
  }
}

await main();
