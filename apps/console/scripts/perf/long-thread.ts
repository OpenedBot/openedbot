// A long thread in a real Chromium (D1d, docs/architecture/0001-refonte-tauri-et-produit.md,
// section 3.4): the bot's real thread, with `--turns` synthetic turns older
// than its history (lib/long-thread-fixture.ts), on a production build served
// like D0. Per trial:
//
//   open      click on the bot -> first messages painted -> live window full;
//   scroll    a steady scroll up then down through what is mounted;
//   load      "load earlier" until the whole history is there, each click timed;
//   scrollAll the same steady scroll through the whole thread;
//   memory    DOM nodes of the thread, JS heap after a GC, Chromium's metrics.
//
// Frames come from requestAnimationFrame, long frames from the Long Animation
// Frames API, both kept inside each phase's own window.
//
//   bun apps/console/scripts/perf/long-thread.ts --env-file <path to .env.local>
//     [--bot Atlas] [--turns 300] [--build <dir>] [--headed] [--runs 1]
//     [--throttle 4] [--speed 40]
//
// Writes tmp/perf/long-thread-<timestamp>.json.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { chromiumPidFor, processTreeRssKb } from "./lib/process-memory";
import { signInWeb } from "./lib/session";
import { startStaticServer } from "./lib/static-server";
import {
  buildLongThreadFixture,
  SYNTHETIC_ATTACHMENT_PREFIX,
  SYNTHETIC_BEFORE_PREFIX,
  syntheticImage,
  type FixtureRealPage,
  type LongThreadFixture,
} from "./lib/long-thread-fixture";

const REPO = resolve(import.meta.dir, "../../../..");
const CONSOLE_DIR = join(REPO, "apps/console");

const { values: args } = parseArgs({
  options: {
    "env-file": { type: "string" },
    bot: { type: "string", default: "Atlas" },
    turns: { type: "string", default: "300" },
    build: { type: "string" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "4182" },
    api: { type: "string", default: "http://127.0.0.1:8790" },
    runs: { type: "string", default: "1" },
    throttle: { type: "string", default: "1" },
    // Pixels per frame of the steady scroll: 40 at 120 Hz is 4 800 px/s, a brisk flick.
    speed: { type: "string", default: "40" },
    "max-loads": { type: "string", default: "40" },
  },
});
const ENV_FILE = resolve(args["env-file"] ?? join(REPO, ".env.local"));
const STAMP = new Date().toISOString().replace(/[:.]/gu, "-");
const OUT_DIR = join(REPO, "tmp/perf");
mkdirSync(OUT_DIR, { recursive: true });
const log = (...parts: unknown[]) => console.log(`[long-thread ${new Date().toISOString().slice(11, 19)}]`, ...parts);

function build(outDir: string): void {
  const result = Bun.spawnSync(["./node_modules/.bin/vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: CONSOLE_DIR,
    env: { ...process.env, OPENEDBOT_CONSOLE_PLUGINS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`vite build failed:\n${result.stderr.toString()}`);
}

// Always on from the first script: long animation frames, and a frame
// recorder the phases switch on and off.
const PROBE = `(() => {
  const origin = performance.timeOrigin;
  const state = { loafs: [], frames: [], recording: false };
  window.__d1d = state;
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) state.loafs.push({
    at: origin + e.startTime, duration: Math.round(e.duration),
    styleAndLayoutMs: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
    scripts: (e.scripts ?? []).slice(0, 3).map((s) => ({ source: (s.sourceFunctionName || s.invoker || "") + " " + (s.sourceURL || "").split("/").pop(), duration: Math.round(s.duration), forcedMs: Math.round(s.forcedStyleAndLayoutDuration ?? 0) })),
  }); }).observe({ type: "long-animation-frame", buffered: true }); } catch {}
  let last = 0;
  const tick = (now) => { if (state.recording && last) state.frames.push([origin + now, now - last]); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;

type Loaf = { at: number; duration: number; styleAndLayoutMs: number; scripts: unknown[] };

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null;
};
const round = (value: number | null, digits = 1) => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Frames and long frames between two page-clock instants (ms since epoch). */
async function window_(page: Page, from: number, to: number) {
  const probe = await page.evaluate(() => {
    const state = (window as unknown as { __d1d: { loafs: Loaf[]; frames: Array<[number, number]> } }).__d1d;
    return { loafs: state.loafs, frames: state.frames };
  }) as { loafs: Loaf[]; frames: Array<[number, number]> };
  const overlaps = (start: number, end: number) => start < to && end > from;
  const frames = probe.frames.filter(([at, delta]) => overlaps(at - delta, at)).map(([, delta]) => delta);
  const loafs = probe.loafs.filter((entry) => overlaps(entry.at, entry.at + entry.duration));
  const median = percentile(frames, 50);
  const total = frames.reduce((sum, delta) => sum + delta, 0);
  return {
    ms: Math.round(to - from),
    frames: frames.length,
    fpsMean: frames.length ? round(frames.length / (total / 1000)) : null,
    fpsP5: frames.length ? round(percentile(frames.map((delta) => 1000 / delta), 5)) : null,
    frameMaxMs: frames.length ? Math.round(Math.max(...frames)) : null,
    droppedPct: frames.length && median ? round((100 * frames.filter((delta) => delta > 1.5 * median).length) / frames.length) : null,
    longFrames: loafs.length,
    longFrameMaxMs: loafs.length ? Math.max(...loafs.map((entry) => entry.duration)) : 0,
    longFrameTotalMs: loafs.reduce((sum, entry) => sum + entry.duration, 0),
    worst: loafs.sort((a, b) => b.duration - a.duration).slice(0, 3).map(({ at, ...entry }) => ({ ...entry, afterMs: Math.round(at - from) })),
  };
}

const now = (page: Page) => page.evaluate(() => performance.timeOrigin + performance.now());

let chromiumPid: number | null = null;

async function memory(page: Page, cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  await Bun.sleep(500);
  const tree = chromiumPid ? processTreeRssKb(chromiumPid) : null;
  const { metrics } = await cdp.send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
  const metric = (name: string) => metrics.find((entry) => entry.name === name)?.value ?? null;
  const dom = await page.evaluate(() => {
    const root = document.querySelector("[data-thread-messages]");
    return {
      threadNodes: root ? root.getElementsByTagName("*").length + 1 : 0,
      documentNodes: document.getElementsByTagName("*").length,
      userTurns: root ? root.querySelectorAll("[data-thread-find-target^='message:']").length : 0,
      scrollHeight: (document.querySelector("[role='log']") as HTMLElement | null)?.scrollHeight ?? 0,
    };
  });
  return {
    ...dom,
    jsHeapMb: round((metric("JSHeapUsedSize") ?? 0) / 2 ** 20),
    // Every Chromium process of the profile (browser, GPU, renderer...), like G3.
    processesRssMb: tree ? Math.round(tree.rssKb / 1024) : null,
    domNodesMetric: metric("Nodes"),
    layoutObjects: metric("LayoutObjects"),
    jsEventListeners: metric("JSEventListeners"),
  };
}

/**
 * Scrolls the thread by `speed` px a frame until it reaches the end in that
 * direction. Each frame also checks the reading position: the block at the
 * middle of the view must move by exactly the scroll, no more. Any other
 * move between two frames (a turn above that grew, an image that decoded)
 * is a jump the reader sees, counted with its size.
 */
async function sweep(page: Page, direction: "up" | "down", speed: number) {
  const from = await now(page);
  const result = await page.evaluate(({ direction, speed }) => new Promise<{ px: number; stoppedBy: string; startHeight: number; endHeight: number; jumps: number; jumpPx: number; jumpMaxPx: number; firstJumps: number[][] }>((done) => {
    const node = document.querySelector<HTMLElement>("[role='log']")!;
    const column = node.querySelector<HTMLElement>("[data-thread-messages]")!;
    const state = (window as unknown as { __d1d: { recording: boolean } }).__d1d;
    state.recording = true;
    let px = 0;
    let still = 0;
    let jumps = 0;
    let jumpPx = 0;
    let jumpMaxPx = 0;
    let frame = 0;
    // The first jumps: [frame, drift, scrollTop, scrollHeight], to tell what moved.
    const firstJumps: number[][] = [];
    let tracked: { element: Element; expectedTop: number } | null = null;
    const startHeight = node.scrollHeight;
    const deadline = performance.now() + 120_000;
    const middleBlock = () => {
      const box = node.getBoundingClientRect();
      let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      while (hit && hit.parentElement !== column) hit = hit.parentElement;
      return hit;
    };
    const step = () => {
      if (tracked && tracked.element.isConnected) {
        const drift = tracked.element.getBoundingClientRect().top - tracked.expectedTop;
        if (Math.abs(drift) > 1) {
          jumps += 1;
          jumpPx += Math.abs(drift);
          jumpMaxPx = Math.max(jumpMaxPx, Math.abs(drift));
          if (firstJumps.length < 6) firstJumps.push([frame, Math.round(drift), Math.round(node.scrollTop), node.scrollHeight]);
        }
      }
      frame += 1;
      const block = middleBlock();
      const blockTop = block?.getBoundingClientRect().top ?? 0;
      const before = node.scrollTop;
      node.scrollTop = before + (direction === "up" ? -speed : speed);
      const moved = node.scrollTop - before;
      px += Math.abs(moved);
      tracked = block ? { element: block, expectedTop: blockTop - moved } : null;
      const atEnd = direction === "up" ? node.scrollTop <= 0 : node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      still = moved === 0 ? still + 1 : 0;
      if (atEnd || still > 30 || performance.now() > deadline) {
        state.recording = false;
        done({ px: Math.round(px), stoppedBy: atEnd ? "end" : still > 30 ? "stuck" : "deadline", startHeight, endHeight: node.scrollHeight, jumps, jumpPx: Math.round(jumpPx), jumpMaxPx: Math.round(jumpMaxPx), firstJumps });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { direction, speed });
  const to = await now(page);
  return { direction, ...result, ...(await window_(page, from, to)) };
}

const loadEarlier = (page: Page) => page.locator("[data-thread-messages] button", { hasText: /Charger|Load/u }).first();

async function settle(page: Page, quietMs = 400, maxMs = 15_000) {
  // Quiet: no DOM mutation in the thread for `quietMs`.
  await page.evaluate(({ quietMs, maxMs }) => new Promise<void>((done) => {
    const root = document.querySelector("[data-thread-messages]") ?? document.body;
    let timer = window.setTimeout(finish, quietMs);
    const stop = window.setTimeout(finish, maxMs);
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(finish, quietMs);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    function finish() {
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(stop);
      done();
    }
  }), { quietMs, maxMs });
}

async function routeThread(context: BrowserContext, threadId: string, author: { id: string; name: string; slug: string; face: unknown }, turns: number) {
  let fixture: LongThreadFixture | null = null;
  let base: Record<string, unknown> | null = null;
  await context.route(new RegExp(`/api/threads/${threadId}/history`, "u"), async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    if (before?.startsWith(SYNTHETIC_BEFORE_PREFIX)) {
      const index = Number(before.slice(SYNTHETIC_BEFORE_PREFIX.length));
      const page = fixture!.pages[index]!;
      const hasMore = index + 1 < fixture!.pages.length;
      await route.fulfill({
        json: {
          ...base!, ...page, approvals: [], settingProposals: [], workflows: [],
          truncated: hasMore,
          history: { hasMore, nextBefore: hasMore ? `${SYNTHETIC_BEFORE_PREFIX}${index + 1}` : null, turnKeys: page.turnKeys },
        },
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as FixtureRealPage & { history?: { hasMore: boolean; nextBefore: string | null; turnKeys: string[] }; truncated: boolean };
    // The oldest real page: the synthetic history continues it.
    if (turns > 0 && body.history && !body.history.hasMore) {
      fixture ??= buildLongThreadFixture({ turns, oldest: body, threadId, author });
      base ??= { ...body, messages: [], runs: [], events: [] };
      body.history = { ...body.history, hasMore: true, nextBefore: `${SYNTHETIC_BEFORE_PREFIX}0` };
      body.truncated = true;
    }
    await route.fulfill({ response, json: body });
  });
  // Synthetic images arrive late, like a real download: they grow their turn after it is mounted.
  await context.route(new RegExp(`/api/attachments/${SYNTHETIC_ATTACHMENT_PREFIX}`, "u"), async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    await Bun.sleep(150 + ([...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 250));
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: syntheticImage(id) });
  });
}

async function trial(page: Page, cdp: CDPSession, botId: string) {
  await page.goto(page.url().replace(/\/[^/]*$/u, "/"));
  await page.locator(`a[href*="/bot/${botId}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
  await Bun.sleep(1_000);
  // Open: from the click to the first painted messages, then to a live window without its growth spacer.
  const clickedAt = await page.evaluate((botId) => {
    const link = document.querySelector<HTMLAnchorElement>(`a[href*="/bot/${botId}"]`)!;
    const at = performance.timeOrigin + performance.now();
    link.click();
    return at;
  }, botId);
  const opened = await page.evaluate(() => new Promise<{ firstPaintAt: number | null; fullAt: number }>((done) => {
    const started = performance.now();
    let sawMessages = false;
    const check = () => {
      const root = document.querySelector("[data-thread-messages]");
      if (root && root.querySelector("[data-thread-find-target]")) sawMessages = true;
      // Before D1d the live window grew after the first paint, behind a spacer.
      const growing = document.querySelector("[data-thread-growth-spacer]");
      const mark = performance.getEntriesByName("openedbot:thread-first-paint")[0];
      if ((sawMessages && mark && !growing) || performance.now() - started > 20_000) {
        done({ firstPaintAt: mark ? performance.timeOrigin + mark.startTime : null, fullAt: performance.timeOrigin + performance.now() });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  await settle(page);
  const openWindow = await window_(page, clickedAt, opened.fullAt + 500);
  const open = {
    firstPaintMs: opened.firstPaintAt ? Math.round(opened.firstPaintAt - clickedAt) : null,
    fullWindowMs: Math.round(opened.fullAt - clickedAt),
    longFrames: openWindow.longFrames,
    longFrameMaxMs: openWindow.longFrameMaxMs,
    longFrameTotalMs: openWindow.longFrameTotalMs,
    worst: openWindow.worst,
    memory: await memory(page, cdp),
  };
  log("open", JSON.stringify({ ...open, worst: undefined }));
  const scroll = [await sweep(page, "up", Number(args.speed)), await sweep(page, "down", Number(args.speed))];
  log("scroll", JSON.stringify(scroll.map(({ worst, ...entry }) => entry)));
  // Load the whole history, one "load earlier" at a time.
  const loads: unknown[] = [];
  for (let click = 0; click < Number(args["max-loads"]); click += 1) {
    const button = loadEarlier(page);
    if (!(await button.count())) break;
    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>("[role='log']")!;
      node.scrollTop = 0;
    });
    await Bun.sleep(150);
    if (!(await button.count())) break;
    const from = await now(page);
    await button.click();
    await settle(page);
    const to = await now(page);
    const measured = await window_(page, from, to);
    loads.push({ click, ms: measured.ms, longFrames: measured.longFrames, longFrameMaxMs: measured.longFrameMaxMs, longFrameTotalMs: measured.longFrameTotalMs });
  }
  await settle(page, 800);
  const loaded = await memory(page, cdp);
  log("loaded", loads.length, "clicks", JSON.stringify(loads), JSON.stringify(loaded));
  // Scroll the whole thread: to the bottom, back to the top, down again.
  const scrollAll = [await sweep(page, "down", Number(args.speed)), await sweep(page, "up", Number(args.speed)), await sweep(page, "down", Number(args.speed))];
  log("scrollAll", JSON.stringify(scrollAll.map(({ worst, ...entry }) => entry)));
  await settle(page, 800);
  const afterScroll = await memory(page, cdp);
  return { open, scroll, loads, loaded, scrollAll, afterScroll };
}

async function main() {
  const buildDir = args.build ? resolve(args.build) : join(OUT_DIR, `long-thread-${STAMP}-build`);
  if (!args.build) {
    log("building the console");
    build(buildDir);
  }
  const server = startStaticServer({ root: buildDir, port: Number(args.port), apiTarget: args.api! });
  const session = await signInWeb(args.api!, new URL(server.origin).hostname, ENV_FILE);
  const raw = await (await fetch(`${args.api}/api/bots`, { headers: { cookie: session.cookieHeader } })).json() as
    Array<{ id: string; name: string; slug?: string; threadId: string; face?: unknown }> | { bots: Array<{ id: string; name: string; slug?: string; threadId: string; face?: unknown }> };
  const bot = (Array.isArray(raw) ? raw : raw.bots).find((candidate) => candidate.name === args.bot);
  if (!bot) throw new Error(`no bot named ${args.bot}`);
  const profileDir = join(OUT_DIR, `long-thread-${STAMP}-profile`);
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
    await context.addInitScript(PROBE);
    await routeThread(context, bot.threadId, { id: bot.id, name: bot.name, slug: bot.slug ?? bot.name.toLowerCase(), face: bot.face ?? null }, Number(args.turns));
    chromiumPid = chromiumPidFor(profileDir);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${server.origin}/`);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (Number(args.throttle) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(args.throttle) });
    for (let run = 0; run < Number(args.runs); run += 1) {
      trials.push(await trial(page, cdp, bot.id));
    }
    await cdp.detach().catch(() => undefined);
  } finally {
    await context.close().catch(() => undefined);
    rmSync(profileDir, { recursive: true, force: true });
    server.stop();
    const out = {
      startedAt: STAMP,
      gitHead: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO }).stdout.toString().trim(),
      build: buildDir, bot: bot.name, turns: Number(args.turns), headed: args.headed, throttle: Number(args.throttle), speed: Number(args.speed),
      trials,
    };
    const outPath = join(OUT_DIR, `long-thread-${STAMP}.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    log("written", outPath);
  }
}

await main();
