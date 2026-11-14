// Where the main thread goes while an answer streams (D1c, the streaming
// smoothness step): one long
// answer from the bot, the same prompt as G4 (lib/streaming.ts), with a CPU
// profile of the page recorded from the first visible text to the end of
// growth. Writes tmp/perf/stream-profile-<timestamp>.json (and the raw
// .cpuprofile next to it, to open in Chrome DevTools).
//
//   bun apps/console/scripts/perf/stream-profile.ts --env-file <path to .env.local>
//     [--bot Atlas] [--build <dir of an existing build>] [--headed] [--runs 1]
//     [--cpu stream|send|none] [--throttle 4]
//
// `--throttle N` slows the page's CPU N times (CDP
// `Emulation.setCPUThrottlingRate`): the M5 Pro this was written on has so
// much headroom that a streamed answer costs it a few percent of a core;
// throttled, the same work shows what a modest machine would pay.
//
// The console is built unminified (`--minify false`) so the profile keeps the
// component and function names. Under `--cpu stream|send` the numbers are an
// attribution, not G4 (profiling slows the page down). With `--cpu none` and
// `--build` pointing at a production build, a trial is d0-baseline's G4 trial
// (same probe, lib/streaming.ts), which is how D1c compares two builds on
// one script: before and after, in a headed window, throttled or not.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { signInWeb } from "./lib/session";
import { measureStreaming, openBotThread } from "./lib/streaming";
import { startStaticServer } from "./lib/static-server";

const REPO = resolve(import.meta.dir, "../../../..");
const CONSOLE_DIR = join(REPO, "apps/console");

const { values: args } = parseArgs({
  options: {
    "env-file": { type: "string" },
    bot: { type: "string", default: "Atlas" },
    build: { type: "string" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "4181" },
    api: { type: "string", default: "http://127.0.0.1:8790" },
    top: { type: "string", default: "40" },
    runs: { type: "string", default: "1" },
    cpu: { type: "string", default: "stream" },
    throttle: { type: "string", default: "1" },
  },
});
const ENV_FILE = resolve(args["env-file"] ?? join(REPO, ".env.local"));
const STAMP = new Date().toISOString().replace(/[:.]/gu, "-");
const OUT_DIR = join(REPO, "tmp/perf");
mkdirSync(OUT_DIR, { recursive: true });
const log = (...parts: unknown[]) => console.log(`[profile ${new Date().toISOString().slice(11, 19)}]`, ...parts);

function build(outDir: string): void {
  const result = Bun.spawnSync(["./node_modules/.bin/vite", "build", "--outDir", outDir, "--emptyOutDir", "--minify", "false"], {
    cwd: CONSOLE_DIR,
    env: { ...process.env, OPENEDBOT_CONSOLE_PLUGINS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`vite build failed:\n${result.stderr.toString()}`);
}

type CallFrame = { functionName: string; url: string; lineNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] };
type CpuProfile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };

/** Self and inclusive time per function, in ms; a recursive function counts once per sample. */
function summarize(profile: CpuProfile, top: number) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const label = (frame: CallFrame) => {
    const file = frame.url ? frame.url.slice(frame.url.lastIndexOf("/") + 1) : "";
    return `${frame.functionName || "(anonymous)"}${file ? ` ${file}:${frame.lineNumber + 1}` : ""}`;
  };
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let idleMs = 0;
  let programMs = 0;
  let busyMs = 0;
  profile.samples.forEach((id, index) => {
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    const node = byId.get(id)!;
    const name = node.callFrame.functionName;
    if (name === "(idle)") {
      idleMs += ms;
      return;
    }
    // Native work outside any script: style, layout, paint, compositing.
    if (name === "(program)") {
      programMs += ms;
      return;
    }
    busyMs += ms;
    self.set(label(node.callFrame), (self.get(label(node.callFrame)) ?? 0) + ms);
    const seen = new Set<string>();
    for (let cursor: number | undefined = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const key = label(byId.get(cursor)!.callFrame);
      if (seen.has(key)) continue;
      seen.add(key);
      total.set(key, (total.get(key) ?? 0) + ms);
    }
  });
  const rank = (map: Map<string, number>) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  return {
    wallMs: Math.round((profile.endTime - profile.startTime) / 1000),
    busyMs: Math.round(busyMs),
    idleMs: Math.round(idleMs),
    programMs: Math.round(programMs),
    self: rank(self),
    inclusive: rank(total),
  };
}

async function main() {
  const buildDir = args.build ? resolve(args.build) : join(OUT_DIR, `stream-profile-${STAMP}-build`);
  if (!args.build) {
    log("building the console (unminified)");
    build(buildDir);
  }
  const server = startStaticServer({ root: buildDir, port: Number(args.port), apiTarget: args.api! });
  const session = await signInWeb(args.api!, new URL(server.origin).hostname, ENV_FILE);
  const raw = await (await fetch(`${args.api}/api/bots`, { headers: { cookie: session.cookieHeader } })).json() as
    Array<{ id: string; name: string; threadId: string }> | { bots: Array<{ id: string; name: string; threadId: string }> };
  const bot = (Array.isArray(raw) ? raw : raw.bots).find((candidate) => candidate.name === args.bot);
  if (!bot) throw new Error(`no bot named ${args.bot}`);
  // The browser profile holds the session cookies: removed when the trials end.
  const profileDir = join(OUT_DIR, `stream-profile-${STAMP}-profile`);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !args.headed,
    viewport: { width: 1280, height: 820 },
    locale: "fr-FR",
  });
  const trials: unknown[] = [];
  try {
    await context.addCookies(session.cookies);
    await context.addInitScript(`try { localStorage.setItem("openedbot:cloud-session", ${JSON.stringify(JSON.stringify(session.cloudSession))}); } catch {}`);
    const page = context.pages()[0] ?? await context.newPage();
    for (let run = 0; run < Number(args.runs); run++) {
      await page.goto(`${server.origin}/`);
      await page.locator(`a[href*="/bot/${bot.id}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
      await openBotThread(page, bot.id);
      const cdp = await context.newCDPSession(page);
      if (Number(args.throttle) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(args.throttle) });
      const cpu = args.cpu;
      if (cpu !== "none") {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      }
      // `--cpu stream` starts with the first visible text (the probe of
      // measureStreaming sets it), so the model's thinking time stays out;
      // `--cpu send` starts with the probe, before Enter.
      let started = false;
      let done = false;
      const starter = (async () => {
        if (cpu === "none") return;
        while (!done) {
          await Bun.sleep(cpu === "send" ? 5 : 50);
          const probe = await page.evaluate(() => {
            const state = (window as unknown as { __d0Stream?: { firstTextAt: number | null } }).__d0Stream;
            return state ? { firstTextAt: state.firstTextAt } : null;
          }).catch(() => null);
          if (probe && (cpu === "send" || probe.firstTextAt !== null)) {
            await cdp.send("Profiler.start");
            started = true;
            return;
          }
        }
      })();
      const measured = await measureStreaming(page, { base: args.api!, cookie: session.cookieHeader, threadId: bot.threadId })
        .finally(() => { done = true; });
      await starter;
      let summary: ReturnType<typeof summarize> | null = null;
      let rawPath: string | null = null;
      if (started) {
        const { profile } = await cdp.send("Profiler.stop") as unknown as { profile: CpuProfile };
        rawPath = join(OUT_DIR, `stream-profile-${STAMP}-${run + 1}.cpuprofile`);
        writeFileSync(rawPath, JSON.stringify(profile));
        summary = summarize(profile, Number(args.top));
      }
      await cdp.detach().catch(() => undefined);
      trials.push({ measured, profile: summary, rawPath });
      log(`run ${run + 1}`, "answer", measured.answerChars, "chars; fps p5", measured.fpsP5, "idle p5", measured.idle.fpsP5, "dropped %", measured.droppedFramePct,
        "; long frames", measured.longAnimationFrames, "pre", measured.preStream.longAnimationFrames,
        summary ? `; busy ${summary.busyMs} ms of ${summary.wallMs}` : "");
    }
  } finally {
    await context.close().catch(() => undefined);
    rmSync(profileDir, { recursive: true, force: true });
    server.stop();
    const out = { startedAt: STAMP, gitHead: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO }).stdout.toString().trim(), bot: bot.name, headed: args.headed, cpu: args.cpu, throttle: Number(args.throttle), trials };
    const outPath = join(OUT_DIR, `stream-profile-${STAMP}.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    log("written", outPath);
  }
}

await main();
