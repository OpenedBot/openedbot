#!/usr/bin/env bun
/**
 * G1 and G3 of ADR 0001 (section 3) on the signed macOS app (D3), with the
 * definitions of the D0 baseline (ADR 0001, section 3.1), so the numbers
 * compare with it:
 *
 *   - G1 marker: the first sidebar link to a bot's thread (`a[href*="/bot/"]`)
 *     visible; wall clock from the process spawn to the poll that saw it.
 *     The signed app has no debugging port: the marker is read from outside,
 *     through the accessibility tree of its WKWebView (`ax-marker.swift`,
 *     polled every 10 ms; WebKit builds that tree for the probe, a cost the
 *     app pays here and not in use, so the numbers can only be pessimistic).
 *   - three cases per trial, one data store: first (session in the Keychain,
 *     WebKit's store and caches emptied), next (relaunch), update (first
 *     launch of build B, another console build id, on that store);
 *   - two networks: local, and 50 ms more per API response (the console
 *     itself is local to the app: there is nothing else to slow down);
 *   - G3: resident memory of the app and of the WebKit processes it started
 *     (content, networking, GPU: XPC services, not its children), 30 s after
 *     a bot's thread was opened, on a warm local launch.
 *
 *   bun apps/desktop-tauri/scripts/perf/perf-mac.ts --app-a /Applications/openedbot.app
 *       --app-b /path/to/other-build/openedbot.app [--runs 5] [--memory-runs 3] [--bot Atlas]
 *       [--port 4180] [--api http://127.0.0.1:8790]
 *   bun apps/desktop-tauri/scripts/perf/perf-mac.ts --relay-only   (the relay alone, to sign the app in)
 *
 * Before: both builds signed with the same Developer ID and identifier (the
 * Keychain session is shared without a prompt), and the app signed in once
 * against the proxy origin `http://127.0.0.1:<port>` (the session is kept per
 * API origin). The app's own data directories are emptied of WebKit data
 * only; the Keychain item and `preferences.json` stay. Writes
 * `tmp/perf/d3-<timestamp>.json`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/** The network between the app and the API: D0's "local" and "simulated network" (one round trip per response). */
type NetworkProfile = { name: string; rttMs: number };
const LOCAL: NetworkProfile = { name: "local", rttMs: 0 };

/**
 * The API relay the app talks to: every `/api` request forwarded to the
 * local API, Origin and preflights included (the CORS answer is the API's
 * own), each response held for the profile's round trip. The same relay
 * as D0's static server (`apps/console/scripts/perf/lib/static-server.ts`),
 * minus the console files: the app carries its own.
 */
function startApiRelay(port: number, apiTarget: string): { origin: string; setNetwork(profile: NetworkProfile): void; stop(): void } {
  let network = LOCAL;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api")) return new Response("not found", { status: 404 });
      const target = new URL(url.pathname + url.search, apiTarget);
      const headers = new Headers(request.headers);
      headers.set("host", target.host);
      headers.delete("accept-encoding");
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        decompress: false,
      } as RequestInit);
      if (network.rttMs > 0) await Bun.sleep(network.rttMs);
      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, setNetwork: (profile) => (network = profile), stop: () => server.stop(true) };
}

const REPO = path.resolve(import.meta.dir, "../../../..");
const OUT_DIR = path.join(REPO, "tmp/perf");
const { values: args } = parseArgs({
  options: {
    "app-a": { type: "string" },
    "app-b": { type: "string" },
    runs: { type: "string", default: "5" },
    "memory-runs": { type: "string", default: "3" },
    bot: { type: "string", default: "Atlas" },
    port: { type: "string", default: "4180" },
    api: { type: "string", default: "http://127.0.0.1:8790" },
    "wan-rtt": { type: "string", default: "50" },
    "idle-seconds": { type: "string", default: "30" },
    "relay-only": { type: "boolean", default: false },
  },
});
const BUNDLE_ID = "app.openedbot.desktop";
const RUNS = Number(args.runs);
const MEMORY_RUNS = Number(args["memory-runs"]);
const WAN: NetworkProfile = { name: "wan", rttMs: Number(args["wan-rtt"]) };
const STAMP = new Date().toISOString().replace(/[:.]/gu, "-");
const log = (...parts: unknown[]) => console.log(`[d3-perf ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

function fail(message: string): never {
  console.error(`[d3-perf] ${message}`);
  process.exit(1);
}

if (args["relay-only"]) {
  const relay = startApiRelay(Number(args.port), args.api!);
  log(`API relay on ${relay.origin} -> ${args.api}; Ctrl-C to stop`);
  await new Promise(() => undefined);
}

const appA = path.resolve(args["app-a"] ?? fail("--app-a is required"));
const appB = path.resolve(args["app-b"] ?? fail("--app-b is required"));
for (const app of [appA, appB]) if (!existsSync(path.join(app, "Contents/MacOS/openedbot"))) fail(`${app} is not the production app (Contents/MacOS/openedbot)`);

// The probe, compiled once.
mkdirSync(OUT_DIR, { recursive: true });
const probe = path.join(OUT_DIR, "ax-marker");
const compiled = Bun.spawnSync(["swiftc", "-O", path.join(import.meta.dir, "ax-marker.swift"), "-o", probe], { stdout: "pipe", stderr: "pipe" });
if (compiled.exitCode !== 0) fail(`swiftc failed: ${compiled.stderr.toString()}`);

/** WebKit's store and caches of the app: what "first launch" empties. */
const WEBKIT_DATA = [path.join(homedir(), "Library/WebKit", BUNDLE_ID), path.join(homedir(), "Library/Caches", BUNDLE_ID)];

function webkitPids(): Set<number> {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,comm="]).stdout.toString();
  return new Set(out.split("\n").filter((line) => /com\.apple\.WebKit\./u.test(line)).map((line) => Number(line.trim().split(/\s+/u)[0])));
}

function rssKb(pids: number[]): number {
  if (!pids.length) return 0;
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", pids.join(",")]).stdout.toString();
  return out.split("\n").map((line) => Number(line.trim())).filter(Number.isFinite).reduce((sum, kb) => sum + kb, 0);
}

type Launch = { proc: Bun.Subprocess; spawnedAt: number; before: Set<number> };

async function launch(app: string, origin: string): Promise<Launch> {
  const before = webkitPids();
  const spawnedAt = Date.now();
  const proc = Bun.spawn([path.join(app, "Contents/MacOS/openedbot")], {
    env: {
      ...process.env,
      OPENEDBOT_API_ORIGIN: origin,
      // Nothing listens there: the first check (30 s in) fails quietly, nothing is downloaded.
      OPENEDBOT_UPDATE_URL: "http://127.0.0.1:9/latest.json",
      OPENEDBOT_POPUP: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return { proc, spawnedAt, before };
}

async function marker(run: Launch, press?: string): Promise<{ wallMs: number; pressed: boolean | null }> {
  const probeArgs = [probe, "--pid", String(run.proc.pid), "--timeout-ms", "60000", "--interval-ms", "10", ...(press ? ["--press", press] : [])];
  // Asynchronous: the API relay runs on this event loop and must keep answering the app meanwhile.
  const child = Bun.spawn(probeArgs, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { found?: boolean; epochMs?: number; pressed?: boolean });
  const seen = lines.find((line) => line.found);
  if (!seen?.epochMs) throw new Error(`marker not seen (${stdout.trim() || stderr.trim()})`);
  return { wallMs: Math.round(seen.epochMs - run.spawnedAt), pressed: lines.find((line) => "pressed" in line)?.pressed ?? null };
}

async function quit(run: Launch): Promise<void> {
  run.proc.kill("SIGTERM");
  const exited = await Promise.race([run.proc.exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
  if (!exited) run.proc.kill("SIGKILL");
  await run.proc.exited;
  // The WebKit services leave with their host: wait until they have, so the next launch starts cold for real.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && [...webkitPids()].some((pid) => !run.before.has(pid))) await Bun.sleep(100);
}

function dropWebKitData(): void {
  for (const dir of WEBKIT_DATA) rmSync(dir, { recursive: true, force: true });
}

// Every launch opens the event stream; the API allows 30 GET /api/events* a minute per client.
let lastLaunch = 0;
async function pace(): Promise<void> {
  const wait = lastLaunch + 4_000 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastLaunch = Date.now();
}

async function main(): Promise<void> {
  const server = startApiRelay(Number(args.port), args.api!);
  const results: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    machine: Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.toString().trim(),
    os: `macOS ${Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim()}`,
    apps: {
      a: { path: appA, version: Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", path.join(appA, "Contents/Info.plist")]).stdout.toString().trim() },
      b: { path: appB, version: Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", path.join(appB, "Contents/Info.plist")]).stdout.toString().trim() },
    },
    marker: 'a[href*="/bot/"] visible, through the WKWebView accessibility tree',
    runs: RUNS,
    networks: [LOCAL, WAN],
  };
  const g1: Record<string, number[]> = {};
  const memory: Array<{ rssKb: number; appKb: number; webkitKb: number; processes: number }> = [];
  const failures: Array<{ trial: string; error: string }> = [];
  try {
    // Signed in against the proxy origin? A launch must reach the marker.
    await pace();
    const check = await launch(appA, server.origin);
    try {
      await marker(check);
    } catch (error) {
      // Thrown, not `fail()`: the app and the relay are stopped by the `finally` blocks first.
      throw new Error(`no thread list on ${server.origin}: sign the app in against this API origin first (${error instanceof Error ? error.message : error})`);
    } finally {
      await quit(check);
    }
    for (let run = 0; run < RUNS; run++) {
      for (const network of [LOCAL, WAN]) {
        server.setNetwork(network);
        dropWebKitData();
        for (const [name, app] of [["first", appA], ["next", appA], ["update", appB]] as const) {
          const key = `${network.name}.${name}`;
          await pace();
          const launched = await launch(app, server.origin);
          try {
            const measureMemory = network === LOCAL && name === "next" && run < MEMORY_RUNS;
            const seen = await marker(launched, measureMemory ? args.bot : undefined);
            (g1[key] ??= []).push(seen.wallMs);
            if (measureMemory) {
              if (!seen.pressed) throw new Error(`the ${args.bot} thread link could not be pressed`);
              await Bun.sleep(Number(args["idle-seconds"]) * 1000);
              const webkit = [...webkitPids()].filter((pid) => !launched.before.has(pid));
              const appKb = rssKb([launched.proc.pid]);
              const webkitKb = rssKb(webkit);
              memory.push({ rssKb: appKb + webkitKb, appKb, webkitKb, processes: 1 + webkit.length });
              log(`G3 run ${run + 1}`, Math.round((appKb + webkitKb) / 1024), "MB", `(app ${Math.round(appKb / 1024)}, WebKit ${Math.round(webkitKb / 1024)}, ${1 + webkit.length} processes)`);
            } else {
              // Let the query cache reach the store before the next launch reads it.
              await Bun.sleep(3_000);
            }
          } catch (error) {
            failures.push({ trial: `${key} run ${run + 1}`, error: error instanceof Error ? error.message : String(error) });
            (g1[key] ??= []).push(Number.NaN);
          } finally {
            await quit(launched);
          }
        }
        log(`G1 ${network.name} run ${run + 1}/${RUNS}`, g1[`${network.name}.first`]?.at(-1), g1[`${network.name}.next`]?.at(-1), g1[`${network.name}.update`]?.at(-1));
      }
    }
  } finally {
    server.stop();
  }
  results.g1 = Object.fromEntries(Object.entries(g1).map(([key, values]) => [key, { median: median(values), values }]));
  results.g3 = { medianMb: memory.length ? Math.round(median(memory.map((sample) => sample.rssKb))! / 1024) : null, samples: memory };
  results.failures = failures;
  results.finishedAt = new Date().toISOString();
  const file = path.join(OUT_DIR, `d3-${STAMP}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  log("written", file);
}

await main();
