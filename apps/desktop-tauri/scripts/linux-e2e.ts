#!/usr/bin/env bun
/**
 * The real path of the Linux shell under Xvfb (ADR 0001, D5), in the image of
 * `linux/Dockerfile`, inside `linux/session.sh` (display + D-Bus session).
 * Driven through WebDriver (tauri-driver + WebKitWebDriver), against the
 * local dev API of the host (`make dev`, runtime of the lab VM).
 *
 *   linux/session.sh --keyring bun scripts/linux-e2e.ts --scenario signed-in --artifacts DIR --evidence DIR
 *   linux/session.sh --no-secret-service bun scripts/linux-e2e.ts --scenario memory-only …
 *   linux/session.sh --keyring bun scripts/linux-e2e.ts --scenario update --artifacts DIR --to-artifacts DIR --to-version V …
 *
 * (`scripts/linux-docker.ts e2e|update` runs these in a fresh container.)
 *
 * signed-in    AppImage: e-mail code sign-in (Mailpit), the bots' threads,
 *              an answer streamed by the bot, the session in the Secret
 *              Service and nowhere in clear, relaunches without sign-in
 *              (launch time, memory at rest), one instance, the deep link,
 *              the tray; then the deb, installed, restores the same session.
 * memory-only  No Secret Service: the session lives in memory only, nothing
 *              in clear on disk, a relaunch asks to sign in again.
 * update       The AppImage replaces itself from the host's local feed
 *              (latest.json), restarts in the new version, then refuses a
 *              manifest signed with another key (forged.json).
 * smoke        CI, no API: the AppImage, then the installed deb, start and
 *              show the embedded console's sign-in page.
 *
 * Every API request of the app goes through `origin-probe.ts` (127.0.0.1:8790
 * in the container), which records the `Origin` WebKitGTK sends and the CORS
 * answer. No token is printed: the checks only report where one was found.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dir, "../../..");
const IDENTIFIER = "app.openedbot.desktop.preview";
const BINARY = "openedbot-desktop-preview";
const SCHEME = "openedbot-preview";
const DRIVER = "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const PROBE_PORT = 8790;
/**
 * The thread list is usable, D0's marker (G1): the first sidebar link to a
 * bot's thread is attached and visible. The shell opens the full console
 * (`window::START_PATH`, since D2b).
 */
const READY = `const link = document.querySelector('a[href*="/bot/"]'); return !!link && link.getClientRects().length > 0;`;

const { values: args } = parseArgs({
  options: {
    scenario: { type: "string", default: "signed-in" },
    artifacts: { type: "string" },
    "to-artifacts": { type: "string" },
    "to-version": { type: "string" },
    evidence: { type: "string", default: "/evidence" },
    api: { type: "string", default: "http://host.docker.internal:8790" },
    mailpit: { type: "string", default: "http://host.docker.internal:8025" },
    // The host's feed (update-feed.ts serve); the manifest's URLs name 127.0.0.1 on the same port.
    "feed-port": { type: "string", default: "8798" },
    email: { type: "string", default: "dev@openedbot.local" },
    bot: { type: "string", default: "Atlas" },
    relaunches: { type: "string", default: "5" },
    "skip-stream": { type: "boolean", default: false },
    "skip-deb": { type: "boolean", default: false },
  },
});
const FEED_PORT = Number(args["feed-port"]);
const EVIDENCE = path.join(path.resolve(args.evidence!), args.scenario!);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });
const report: Record<string, unknown> = { scenario: args.scenario, startedAt: new Date().toISOString() };
const children: ChildProcess[] = [];
let shot = 0;

const log = (...parts: unknown[]) => console.log(`[linux-e2e ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new Error(message);
}

function sh(command: string, argv: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", env: options.env ?? process.env, timeout: options.timeout ?? 60_000 });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function onlyFile(dir: string, suffix: string): string {
  const found = readdirSync(dir).filter((name) => name.endsWith(suffix));
  if (found.length !== 1) fail(`expected one *${suffix} in ${dir}, found ${found.length}`);
  return path.join(dir, found[0]!);
}

// ─── Host services seen from the container ─────────────────────────────────

/** `origin-probe.ts` on 127.0.0.1:8790 → the host's API; every line kept as evidence. */
async function startProbe(): Promise<void> {
  const probe = spawn("bun", [path.join(ROOT, "apps/desktop-tauri/scripts/origin-probe.ts"), String(PROBE_PORT), args.api!], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(probe);
  const lines: string[] = [];
  probe.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      lines.push(line);
      writeFileSync(path.join(EVIDENCE, "origin-probe.jsonl"), `${lines.filter((entry) => entry.startsWith("{")).join("\n")}\n`);
    }
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const ok = await fetch(`http://127.0.0.1:${PROBE_PORT}/api/health`).then((response) => response.ok, () => false);
    if (ok) return;
    await sleep(200);
  }
  fail(`the API is not reachable through the probe (${args.api})`);
}

/** The host's update feed, seen on 127.0.0.1 in the container: the only http feed `config.rs` accepts. */
function startFeedForwarder(): void {
  Bun.serve({
    hostname: "127.0.0.1",
    port: FEED_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(`http://host.docker.internal:${FEED_PORT}${url.pathname}`);
      log(`feed ${url.pathname} -> ${response.status}`);
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
}

async function readMailpitCode(since: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${args.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${args.email}"`)}&limit=5`)).json()) as {
      messages?: Array<{ ID: string; Created: string }>;
    };
    for (const message of list.messages ?? []) {
      if (Date.parse(message.Created) < since - 2_000) continue;
      const full = (await (await fetch(`${args.mailpit}/api/v1/message/${message.ID}`)).json()) as { Text?: string };
      const code = /\b(\d{6})\b/u.exec(full.Text ?? "")?.[1];
      if (code) return code;
    }
    await sleep(500);
  }
  fail(`no e-mail code reached Mailpit for ${args.email} within 30 s`);
}

// ─── The app under WebDriver ───────────────────────────────────────────────

const APP_ENV: Record<string, string> = {
  OPENEDBOT_API_ORIGIN: `http://127.0.0.1:${PROBE_PORT}`,
  OPENEDBOT_PUBLIC_CONSOLE_URL: "http://localhost:5173",
  APPIMAGE_EXTRACT_AND_RUN: "1",
};

function startDriver(): void {
  const driver = spawn("tauri-driver", ["--port", "4444", "--native-port", "4445", "--native-driver", "/usr/bin/WebKitWebDriver"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...APP_ENV },
  });
  driver.stderr!.on("data", (chunk: Buffer) => writeFileSync(path.join(EVIDENCE, "tauri-driver.log"), chunk, { flag: "a" }));
  children.push(driver);
}

async function wd<T = unknown>(method: string, route: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  // Bounded: a launch that never connects (a second instance handing over to a
  // first one still running) must fail the run, not hang it.
  const response = await fetch(`${DRIVER}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as { value?: T & { error?: string; message?: string } };
  if (!response.ok) fail(`WebDriver ${method} ${route}: ${response.status} ${payload.value?.error ?? ""} ${payload.value?.message?.slice(0, 300) ?? ""}`);
  return payload.value as T;
}

type Session = { id: string; spawnedAt: number };

async function launch(application: string): Promise<Session> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await fetch(`${DRIVER}/status`).then((response) => response.ok, () => false)) break;
    await sleep(200);
  }
  const spawnedAt = performance.now();
  const value = await wd<{ sessionId: string }>("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application } } } });
  return { id: value.sessionId, spawnedAt };
}

async function quit(session: Session): Promise<void> {
  await wd("DELETE", `/session/${session.id}`, undefined, 15_000).catch((error) => log(`session close: ${error}`));
  // The app (and its WebKit processes) must be gone before the next launch:
  // WebKitWebDriver closes the web view, not always the app (the tray keeps
  // it alive, as for a user who closes the window), so it is asked to quit.
  for (let attempt = 0; attempt < 25 && appPids().length; attempt++) await sleep(200);
  for (const pid of appPids()) process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && appPids().length; attempt++) await sleep(200);
  if (appPids().length) fail("the app did not quit");
}

const run = <T = unknown>(session: Session, script: string, scriptArgs: unknown[] = []) =>
  wd<T>("POST", `/session/${session.id}/execute/sync`, { script, args: scriptArgs });

/** A bridge command from the page, like the console does (`tauri-bridge.ts`). */
const invoke = <T = unknown>(session: Session, command: string) =>
  wd<T>("POST", `/session/${session.id}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).then((value) => done({ ok: value }), (error) => done({ error: String(error) }));`,
    args: [],
  }) as Promise<{ ok?: T; error?: string }>;

async function find(session: Session, css: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await wd<Array<Record<string, string>>>("POST", `/session/${session.id}/elements`, { using: "css selector", value: css }).catch(() => []);
    if (found.length) return found[0]![ELEMENT]!;
    await sleep(150);
  }
  fail(`${css} not found within ${timeoutMs} ms`);
}

const click = (session: Session, element: string) => wd("POST", `/session/${session.id}/element/${element}/click`, {});
const type = (session: Session, element: string, text: string) => wd("POST", `/session/${session.id}/element/${element}/value`, { text });

async function until(session: Session, script: string, timeoutMs: number, everyMs = 25): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run<boolean>(session, script).catch(() => false)) return performance.now();
    await sleep(everyMs);
  }
  fail(`condition not met within ${timeoutMs} ms: ${script.slice(0, 120)}`);
}

/** Two pictures: the WebView's own (WebDriver) and the whole X screen (`import`), which shows the real window. */
/** Returns the stem of the two pictures (`<stem>.x11.png`, `<stem>.webview.png`). */
async function capture(session: Session | null, name: string): Promise<string> {
  shot += 1;
  const stem = path.join(EVIDENCE, `${String(shot).padStart(2, "0")}-${name}`);
  const x = sh("import", ["-window", "root", `${stem}.x11.png`]);
  if (x.code !== 0) log(`X screenshot failed: ${x.out}`);
  if (session) {
    const png = await wd<string>("GET", `/session/${session.id}/screenshot`).catch(() => null);
    if (png) writeFileSync(`${stem}.webview.png`, Buffer.from(png, "base64"));
  }
  log(`captured ${path.basename(stem)}`);
  return stem;
}

// ─── Processes and files ───────────────────────────────────────────────────

function processTable(): Array<{ pid: number; ppid: number; rssKb: number; name: string; exe: string }> {
  const rows = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const field = (name: string) => new RegExp(`^${name}:\\s+(.+)$`, "m").exec(status)?.[1] ?? "";
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${entry}/exe`);
      } catch {}
      rows.push({ pid: Number(entry), ppid: Number(field("PPid")), rssKb: Number.parseInt(field("VmRSS") || "0", 10), name: field("Name"), exe });
    } catch {}
  }
  return rows;
}

function appPids(): number[] {
  return processTable().filter((row) => path.basename(row.exe) === BINARY).map((row) => row.pid);
}

/** RSS of the app and every process under it (WebKit's web and network processes, the sandbox). */
function appMemory(): { totalMb: number; processes: Array<{ name: string; rssMb: number }> } {
  const table = processTable();
  const roots = table.filter((row) => path.basename(row.exe) === BINARY).map((row) => row.pid);
  if (!roots.length) fail("the app process is not running");
  const tree = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of table) if (tree.has(row.ppid) && !tree.has(row.pid)) {
      tree.add(row.pid);
      grew = true;
    }
  }
  const processes = table.filter((row) => tree.has(row.pid)).map((row) => ({ name: row.name, rssMb: Math.round(row.rssKb / 102.4) / 10 }));
  return { totalMb: Math.round(processes.reduce((sum, row) => sum + row.rssMb, 0)), processes };
}

/** Files under `dir` whose bytes contain `needle` (a token: only paths are reported). */
function filesContaining(dir: string, needle: string): string[] {
  if (!needle || !existsSync(dir)) return [];
  const result = sh("grep", ["-rlsF", "--binary-files=text", "--", needle, dir]);
  return result.out ? result.out.split("\n").filter(Boolean) : [];
}

const appLog = () => path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local/share"), IDENTIFIER, "logs/preview.log");
const readAppLog = () => (existsSync(appLog()) ? readFileSync(appLog(), "utf8") : "");

function wipeAppData(): void {
  for (const base of [".local/share", ".config", ".cache"]) rmSync(path.join(homedir(), base, IDENTIFIER), { recursive: true, force: true });
}

function prepareAppImage(dir: string, target: string): string {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(onlyFile(dir, ".AppImage"), target);
  chmodSync(target, 0o755);
  return target;
}

// ─── Steps ─────────────────────────────────────────────────────────────────

async function signIn(session: Session): Promise<number> {
  const email = await find(session, "#si-email", 60_000);
  await capture(session, "login");
  await type(session, email, args.email!);
  const since = Date.now();
  await click(session, await find(session, "form.si-form button[type=submit]"));
  const code = await readMailpitCode(since);
  const otp = await find(session, ".si-otp input");
  await capture(session, "code-step");
  // Six digits: the form verifies by itself (login.tsx).
  await type(session, otp, code);
  const ready = await until(session, READY, 60_000, 100);
  log("signed in, threads shown");
  return ready;
}

/** The sidebar's list of the bots' threads, then the chosen bot's thread. */
async function openThreads(session: Session, bot: string): Promise<string[]> {
  const links = `[...document.querySelectorAll('a[href*="/bot/"]')].filter((link) => link.getClientRects().length > 0)`;
  const names = await run<string[]>(session, `return [...new Set(${links}.map((link) => link.textContent.trim()).filter(Boolean))];`);
  // The marker is in the DOM; give the compositor a moment before the X picture.
  await sleep(1_000);
  await capture(session, "thread-list");
  const link = await run<Record<string, string> | null>(session, `return ${links}.find((link) => link.textContent.trim().startsWith(arguments[0])) ?? null;`, [bot]);
  if (!link) fail(`no thread for ${bot} in ${names.join(", ")}`);
  await click(session, link[ELEMENT]!);
  await find(session, "[data-thread-composer] textarea");
  await sleep(1_500);
  return names;
}

// Same probe and prompt as the D0 baseline (apps/console/scripts/perf/lib/streaming.ts):
// the answer's growth timestamped in the page, every frame interval recorded.
// WebKit has neither `longtask` nor `long-animation-frame`: frames only.
const STREAM_PROBE = `(() => {
  const origin = performance.timeOrigin;
  const known = new WeakSet(document.querySelectorAll("[data-assistant-response]"));
  const state = { frames: [], running: true, answerChars: 0, firstTextAt: null, lastGrowthAt: null };
  window.__d5Stream = state;
  const measure = () => {
    const fresh = [...document.querySelectorAll("[data-assistant-response]")].filter((node) => !known.has(node));
    const answer = fresh.at(-1);
    const length = answer ? (answer.textContent || "").length : 0;
    if (length > state.answerChars) {
      const now = origin + performance.now();
      if (state.firstTextAt === null && length >= 20) state.firstTextAt = now;
      state.answerChars = length;
      state.lastGrowthAt = now;
    }
  };
  const observer = new MutationObserver(measure);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  let last = performance.now();
  const tick = (now) => { state.frames.push([origin + now, now - last]); last = now; if (state.running) requestAnimationFrame(tick); else observer.disconnect(); };
  requestAnimationFrame(tick);
})();`;
const STREAM_PROMPT =
  "Test de performance de l'interface, pas de recherche : sans utiliser aucun outil, écris d'une traite un texte " +
  "d'environ 1 500 mots (au moins 12 paragraphes, avec des titres Markdown, deux listes à puces et un petit tableau) " +
  "sur l'histoire des machines à écrire. Ne pose aucune question, réponds directement.";

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))]! : null;
};

async function stream(session: Session, token: string, bot: string): Promise<Record<string, unknown>> {
  const auth = { authorization: `Bearer ${token}` };
  const raw = (await (await fetch(`${args.api}/api/bots`, { headers: auth })).json()) as Array<{ name: string; threadId: string }> | { bots: Array<{ name: string; threadId: string }> };
  const threadId = (Array.isArray(raw) ? raw : raw.bots).find((entry) => entry.name === bot)?.threadId ?? fail(`no thread id for ${bot}`);
  const latestRun = async (since: number) => {
    const thread = (await (await fetch(`${args.api}/api/threads/${threadId}`, { headers: auth, signal: AbortSignal.timeout(15_000) })).json()) as { runs?: Array<{ id: string; status: string; createdAt: string; error?: string | null }> };
    // Ours is the first run opened after the send (another client may open one a moment later).
    const fresh = (thread.runs ?? []).filter((entry) => Date.parse(entry.createdAt) >= since - 2_000).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return (runId ? fresh.find((entry) => entry.id === runId) : fresh[0]) ?? null;
  };
  // The thread is shared (other tests may be talking to the bot): wait for it
  // to be idle, or the prompt is folded into another run's reply.
  const busy = ["queued", "pending", "starting", "running", "awaiting_approval"];
  for (let waited = 0; ; waited += 2_000) {
    const thread = (await (await fetch(`${args.api}/api/threads/${threadId}`, { headers: auth })).json()) as { runs?: Array<{ status: string }> };
    if (!(thread.runs ?? []).some((entry) => busy.includes(entry.status))) break;
    if (waited > 5 * 60_000) fail("the thread stayed busy for 5 min");
    await sleep(2_000);
  }
  await run(session, STREAM_PROBE);
  await sleep(3_500);
  const idleTo = Date.now();
  const composer = await find(session, "[data-thread-composer] textarea");
  await type(session, composer, STREAM_PROMPT);
  const sentAt = Date.now();
  await type(session, composer, "");
  const deadline = sentAt + 8 * 60_000;
  let status: string | null = null;
  let runId: string | null = null;
  let midShot = false;
  let interruptedSeen = false;
  for (;;) {
    if (Date.now() > deadline) fail("the streamed answer did not finish within 8 min");
    await sleep(500);
    const growth = await run<{ answerChars: number; lastGrowthAt: number | null }>(session, "return { answerChars: window.__d5Stream.answerChars, lastGrowthAt: window.__d5Stream.lastGrowthAt };");
    if (!midShot && growth.answerChars > 600) {
      midShot = true;
      await capture(session, "streaming");
    }
    interruptedSeen ||= await run<boolean>(session, `return !!document.querySelector('[data-run-activity="interrupted"]');`).catch(() => false);
    const latest = await latestRun(sentAt).catch(() => null);
    if (latest && (latest.status !== status || latest.id !== runId)) log(`run ${latest.id} ${latest.status}, ${growth.answerChars} chars shown`);
    status = latest?.status ?? status;
    runId = latest?.id ?? runId;
    if (status && ["completed", "failed", "cancelled", "unknown"].includes(status) && Date.now() - (growth.lastGrowthAt ?? sentAt) > 2_000) break;
  }
  const probe = await run<{ frames: Array<[number, number]>; answerChars: number; firstTextAt: number | null; lastGrowthAt: number | null }>(
    session,
    "window.__d5Stream.running = false; return window.__d5Stream;",
  );
  await capture(session, "streamed");
  const from = probe.firstTextAt ?? Number.POSITIVE_INFINITY;
  const to = (probe.lastGrowthAt ?? sentAt) + 250;
  const frames = probe.frames.filter(([at, delta]) => at - delta < to && at > from).map(([, delta]) => delta);
  const idle = probe.frames.filter(([at, delta]) => at - delta < idleTo && at > idleTo - 3_000).map(([, delta]) => delta);
  const median = percentile(frames, 50);
  // Streamed through the event stream, or caught up by polling the history?
  const polls = existsSync(path.join(EVIDENCE, "origin-probe.jsonl"))
    ? readFileSync(path.join(EVIDENCE, "origin-probe.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: string; method: string; path: string })
      .filter((line) => line.method === "GET" && line.path.endsWith("/history") && Date.parse(line.at) >= sentAt && Date.parse(line.at) <= to).length
    : null;
  return {
    runId,
    runStatus: status,
    interruptedBannerSeen: interruptedSeen,
    historyPollsDuringStream: polls,
    timeToFirstTextMs: probe.firstTextAt ? Math.round(probe.firstTextAt - sentAt) : null,
    streamMs: probe.firstTextAt && probe.lastGrowthAt ? Math.round(probe.lastGrowthAt - probe.firstTextAt) : 0,
    answerChars: probe.answerChars,
    frames: frames.length,
    fpsMean: frames.length ? Math.round((frames.length / (frames.reduce((sum, d) => sum + d, 0) / 1000)) * 10) / 10 : null,
    fpsP5: frames.length ? Math.round(percentile(frames.map((d) => 1000 / d), 5)! * 10) / 10 : null,
    framesOver50ms: frames.filter((d) => d > 50).length,
    frameMaxMs: frames.length ? Math.round(Math.max(...frames)) : null,
    droppedFramePct: frames.length ? Math.round((frames.filter((d) => d > 1.5 * median!).length / frames.length) * 1000) / 10 : null,
    idleFpsMean: idle.length ? Math.round((idle.length / (idle.reduce((sum, d) => sum + d, 0) / 1000)) * 10) / 10 : null,
  };
}

/** What the probe saw: the `Origin` of the page's requests and the API's CORS answers. */
function originSummary(): Record<string, unknown> {
  const file = path.join(EVIDENCE, "origin-probe.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  const count = (pick: (line: Record<string, unknown>) => unknown) => {
    const counts: Record<string, number> = {};
    for (const line of lines) {
      const key = String(pick(line));
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  return {
    requests: lines.length,
    origins: count((line) => line.origin),
    allowOrigin: count((line) => line.allowOrigin),
    allowCredentials: count((line) => line.allowCredentials),
    withCookie: lines.filter((line) => line.cookie).length,
    preflights: lines.filter((line) => line.method === "OPTIONS").length,
    eventStreams: lines.filter((line) => String(line.contentType ?? "").startsWith("text/event-stream")).length,
    refused: lines.filter((line) => Number(line.status) >= 400).map((line) => `${line.status} ${line.method} ${line.path} ${line.errorCode ?? ""}`).slice(0, 20),
  };
}

/** Second launch while one runs: it must hand over to the first and exit (single instance + deep link). */
function secondLaunch(executable: string): Record<string, unknown> {
  const before = readAppLog().length;
  const started = performance.now();
  const second = sh(executable, [`${SCHEME}://open`], { env: { ...process.env, ...APP_ENV }, timeout: 30_000 });
  const elapsed = Math.round(performance.now() - started);
  const added = readAppLog().slice(before);
  return {
    exitCode: second.code,
    exitedMs: elapsed,
    stillOneInstance: appPids().length === 1,
    deepLinkSeen: added.includes(`deep link ${SCHEME}://open`),
  };
}

function installDeb(deb: string) {
  const root = process.getuid?.() === 0;
  return sh(root ? "dpkg" : "sudo", root ? ["-i", deb] : ["dpkg", "-i", deb], { timeout: 120_000 });
}

/**
 * The invariants a scenario stands for: all recorded in the report, and the
 * scenario fails (exit 1) when one does not hold, so a regression cannot pass
 * as a run that merely measured something.
 */
function verify(checks: Record<string, boolean>): void {
  report.checks = { ...(report.checks as Record<string, boolean> | undefined), ...checks };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) fail(`checks failed: ${failed.join(", ")}`);
}

/** The page talks to the API from `tauri://localhost` only, bearer, no cookie, no credentialed CORS. */
function originChecks(): Record<string, boolean> {
  const origin = originSummary() as { origins: Record<string, number>; allowCredentials: Record<string, number>; withCookie: number };
  return {
    originIsTauriLocalhost: Object.keys(origin.origins).every((value) => value === "tauri://localhost" || value === "null") && (origin.origins["tauri://localhost"] ?? 0) > 0,
    corsAnswersTheOrigin: Object.keys((originSummary() as { allowOrigin: Record<string, number> }).allowOrigin).every((value) => value === "tauri://localhost" || value === "null"),
    noCredentialedCors: Object.keys(origin.allowCredentials).every((value) => value === "null"),
    noCookie: origin.withCookie === 0,
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

async function signedIn(): Promise<void> {
  const artifacts = args.artifacts ?? fail("--artifacts is required");
  const appimage = prepareAppImage(artifacts, "/tmp/apps/openedbot-preview.AppImage");
  wipeAppData();
  await startProbe();
  // An XEmbed tray for the tray icon (libayatana-appindicator falls back to it without a StatusNotifier host).
  const tray = spawn("stalonetray", ["--geometry", "6x1-0+0", "--icon-size", "32", "--background", "#333333"], { stdio: "ignore" });
  children.push(tray);
  startDriver();

  // 1. First launch, sign-in, the threads.
  const first = await launch(appimage);
  const shown = await signIn(first);
  report.signInToThreadsMs = Math.round(shown - first.spawnedAt);
  const names = await openThreads(first, args.bot!);
  report.threads = names;
  await capture(first, "bot-thread");

  // 2. The session: in the Secret Service, nowhere in clear.
  const info = await invoke<{ persistence: string; platform: string; version: string }>(first, "shell_info");
  const access = (await invoke<string | null>(first, "read_access_token")).ok ?? fail("no access token after sign-in");
  const stored = sh("secret-tool", ["search", "--all", "service", IDENTIFIER]);
  const secret = /^secret = (.+)$/m.exec(stored.out)?.[1] ?? "";
  const refresh = secret ? ((JSON.parse(secret) as { refreshToken?: string }).refreshToken ?? "") : "";
  report.session = {
    shellInfo: info.ok,
    inSecretService: secret.length > 0,
    secretServiceLabel: /^label = (.+)$/m.exec(stored.out)?.[1] ?? null,
    refreshTokenInClear: filesContaining(homedir(), refresh).concat(filesContaining("/tmp", refresh)),
    accessTokenInClear: filesContaining(homedir(), access).concat(filesContaining("/tmp", access)),
  };
  log("session", JSON.stringify(report.session));

  // 3. A streamed answer.
  if (!args["skip-stream"]) report.stream = await stream(first, access, args.bot!);

  // 4. One instance, the deep link (direct argument, then through the
  // registered handler as a desktop opens it: `gio open`, GLib's launcher; the
  // generic mode of xdg-open cannot parse a quoted Exec line).
  report.secondInstance = secondLaunch(appimage);
  const handler = sh("xdg-mime", ["query", "default", `x-scheme-handler/${SCHEME}`]);
  const before = readAppLog().length;
  const opened = sh("gio", ["open", `${SCHEME}://open`], { timeout: 30_000 });
  await sleep(3_000);
  report.deepLink = {
    registeredHandler: handler.out || null,
    handlerEntry: sh("bash", ["-c", `cat ${homedir()}/.local/share/applications/*handler*.desktop 2>/dev/null`]).out || null,
    gioOpenExit: opened.code,
    receivedThroughGioOpen: readAppLog().slice(before).includes(`deep link ${SCHEME}://open`),
    instances: appPids().length,
  };
  const afterDeepLink = await capture(first, "after-deep-link");

  // 5. The close button hides the window; a second launch shows the same one again.
  const visible = () => sh("xdotool", ["search", "--onlyvisible", "--name", "openedbot preview"]).out.split("\n").filter(Boolean);
  const [mainWindow] = visible();
  const closeSent = mainWindow ? sh("python3", [path.join(ROOT, "apps/desktop-tauri/linux/wm-close.py"), mainWindow]).code === 0 : false;
  await sleep(2_000);
  const afterClose = { running: appPids().length, visibleWindows: visible().length };
  await capture(null, "after-close");
  sh(appimage, [], { env: { ...process.env, ...APP_ENV }, timeout: 30_000 });
  await sleep(2_000);
  report.closeButton = { window: mainWindow ?? null, closeSent, afterClose, afterRelaunch: { running: appPids().length, visibleWindows: visible().length } };
  // An icon docked in the XEmbed tray is a child window of stalonetray's.
  const trayWindow = sh("xdotool", ["search", "--class", "stalonetray"]).out.split("\n").filter(Boolean)[0];
  // stalonetray sits in the top right corner (geometry below): its strip, enlarged.
  const trayPicture = sh("convert", [`${afterDeepLink}.x11.png`, "-crop", "200x40+1080+0", "-scale", "400%", path.join(EVIDENCE, "tray.png")]);
  if (trayPicture.code !== 0) log(`tray picture not cropped: ${trayPicture.out}`);
  report.tray = { dockedIcons: trayWindow ? Number(/(\d+) child/.exec(sh("xwininfo", ["-children", "-id", trayWindow]).out)?.[1] ?? 0) : null };
  await quit(first);

  // 6. Relaunches: session restored from the Secret Service, time to the threads, memory at rest.
  const relaunches: Array<Record<string, unknown>> = [];
  for (let index = 0; index < Number(args.relaunches); index++) {
    const session = await launch(appimage);
    const ready = await until(session, READY, 60_000);
    const pageMs = await run<number>(session, "return Math.round(performance.now());");
    const entry: Record<string, unknown> = { wallMs: Math.round(ready - session.spawnedAt), pageMs };
    if (index === Number(args.relaunches) - 1) {
      await sleep(20_000);
      report.memoryAtRest = appMemory();
      await capture(session, "relaunched-at-rest");
    }
    relaunches.push(entry);
    await quit(session);
  }
  report.relaunches = relaunches;
  const walls = relaunches.map((entry) => Number(entry.wallMs));
  report.relaunchMedianMs = percentile(walls, 50);
  const session = report.session as { shellInfo?: { persistence?: string; platform?: string }; inSecretService: boolean; refreshTokenInClear: string[]; accessTokenInClear: string[] };
  const streamed = report.stream as { runStatus: string | null; answerChars: number; interruptedBannerSeen: boolean; historyPollsDuringStream: number | null } | undefined;
  const second = report.secondInstance as { exitCode: number | null; stillOneInstance: boolean; deepLinkSeen: boolean };
  const deepLink = report.deepLink as { registeredHandler: string | null; receivedThroughGioOpen: boolean; instances: number };
  verify({
    platformIsLinux: session.shellInfo?.platform === "linux",
    sessionInSecretService: session.shellInfo?.persistence === "keystore" && session.inSecretService,
    noRefreshTokenInClear: session.refreshTokenInClear.length === 0,
    noAccessTokenInClear: session.accessTokenInClear.length === 0,
    ...(streamed ? {
      answerStreamed: streamed.runStatus === "completed" && streamed.answerChars > 0,
      throughTheEventStream: !streamed.interruptedBannerSeen && streamed.historyPollsDuringStream === 0,
    } : {}),
    // The second process exits at once and leaves one instance, which got the link.
    secondLaunchHandsOver: second.exitCode === 0 && second.stillOneInstance,
    deepLinkByArgument: second.deepLinkSeen,
    deepLinkByHandler: deepLink.registeredHandler !== null && deepLink.receivedThroughGioOpen && deepLink.instances === 1,
    closeHidesThenRelaunchShows: (() => {
      const close = report.closeButton as { window: string | null; closeSent: boolean; afterClose: { running: number; visibleWindows: number }; afterRelaunch: { running: number; visibleWindows: number } };
      return close.window !== null && close.closeSent && close.afterClose.running === 1 && close.afterClose.visibleWindows === 0 && close.afterRelaunch.running === 1 && close.afterRelaunch.visibleWindows === 1;
    })(),
    trayIconDocked: Number((report.tray as { dockedIcons: number | null }).dockedIcons) > 0,
    relaunchesRestoreTheSession: relaunches.length === Number(args.relaunches),
    ...originChecks(),
  });

  // 7. The deb, installed: same identity, so the same session.
  if (!args["skip-deb"]) {
    const deb = onlyFile(artifacts, ".deb");
    const installed = installDeb(deb);
    const desktop = sh("bash", ["-c", "cat /usr/share/applications/*openedbot*.desktop"]);
    // An update feed configured: the deb must not try to replace itself.
    const configDir = path.join(homedir(), ".config", IDENTIFIER);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ updateUrl: `http://127.0.0.1:${FEED_PORT}/latest.json` }));
    const session = await launch(`/usr/bin/${BINARY}`);
    const ready = await until(session, READY, 60_000);
    report.deb = {
      dpkgExit: installed.code,
      desktopEntry: desktop.out,
      dependsOk: sh("dpkg", ["-s", "openedbot-preview"]).out.includes("Status: install ok installed"),
      relaunchWallMs: Math.round(ready - session.spawnedAt),
      skippedUpdates: readAppLog().includes("not an AppImage"),
    };
    rmSync(path.join(configDir, "config.json"), { force: true });
    const packaged = report.deb as { dpkgExit: number | null; dependsOk: boolean; skippedUpdates: boolean; desktopEntry: string };
    verify({
      debInstalls: packaged.dpkgExit === 0 && packaged.dependsOk,
      debDeclaresTheScheme: packaged.desktopEntry.includes(`MimeType=x-scheme-handler/${SCHEME}`),
      debLeavesUpdatesToThePackageManager: packaged.skippedUpdates,
    });
    await capture(session, "deb-threads");
    await quit(session);
  }
}

async function memoryOnly(): Promise<void> {
  const artifacts = args.artifacts ?? fail("--artifacts is required");
  const appimage = prepareAppImage(artifacts, "/tmp/apps/openedbot-preview.AppImage");
  wipeAppData();
  await startProbe();
  startDriver();
  const first = await launch(appimage);
  await signIn(first);
  const info = await invoke<{ persistence: string }>(first, "shell_info");
  const access = (await invoke<string | null>(first, "read_access_token")).ok ?? fail("no access token after sign-in");
  report.session = {
    shellInfo: info.ok,
    secretServiceOnBus: sh("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"]).out.includes("boolean true"),
    accessTokenInClear: filesContaining(homedir(), access).concat(filesContaining("/tmp", access)),
    logSaysMemoryOnly: readAppLog().includes("session kept in memory only"),
  };
  await capture(first, "memory-only-signed-in");
  await quit(first);
  const again = await launch(appimage);
  await find(again, "#si-email", 60_000);
  report.relaunchAsksToSignIn = true;
  const session = report.session as { shellInfo?: { persistence?: string }; secretServiceOnBus: boolean; accessTokenInClear: string[]; logSaysMemoryOnly: boolean };
  verify({
    noSecretServiceOnTheBus: !session.secretServiceOnBus,
    sessionInMemoryOnly: session.shellInfo?.persistence === "memory-only" && session.logSaysMemoryOnly,
    noAccessTokenInClear: session.accessTokenInClear.length === 0,
    ...originChecks(),
  });
  await capture(again, "memory-only-relaunch");
  await quit(again);
}

async function update(): Promise<void> {
  const from = args.artifacts ?? fail("--artifacts is required");
  const to = args["to-artifacts"] ?? fail("--to-artifacts is required");
  const toVersion = args["to-version"] ?? fail("--to-version is required");
  wipeAppData();
  await startProbe();
  startFeedForwarder();
  const appimage = prepareAppImage(from, "/tmp/update/openedbot-preview.AppImage");
  const fromSha = sha256(appimage);
  const expected = sha256(onlyFile(to, ".AppImage"));
  // Launched like a user would, no driver: the updater checks 3 s after start.
  const start = (manifest: string) =>
    spawn(appimage, [], { stdio: "ignore", detached: true, env: { ...process.env, ...APP_ENV, OPENEDBOT_UPDATE_URL: `http://127.0.0.1:${FEED_PORT}/${manifest}` } });

  // 1. A genuine update: downloaded, verified, the file replaced, restarted in the new version.
  start("latest.json");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !readAppLog().includes(`openedbot preview ${toVersion},`)) await sleep(1_000);
  await sleep(4_000);
  const updatedLog = readAppLog();
  report.install = {
    fromSha,
    afterSha: sha256(appimage),
    replacedByTheNewVersion: sha256(appimage) === expected,
    downloadedAndVerified: updatedLog.includes("signature verified"),
    // The updater logs "update <version> installed" before it restarts the app.
    restartedIn: /openedbot preview (\S+), API/.exec(updatedLog.split(/update \S+ installed/).at(-1) ?? "")?.[1] ?? null,
    running: appPids().length,
  };
  await capture(null, "updated-running");
  for (const pid of appPids()) process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && appPids().length; attempt++) await sleep(200);

  // 2. A manifest signed with another key: refused, the file untouched.
  const before = readAppLog().length;
  const kept = sha256(appimage);
  start("forged.json");
  const refusedBy = Date.now() + 120_000;
  while (Date.now() < refusedBy && !readAppLog().slice(before).includes("update refused or failed")) await sleep(1_000);
  const added = readAppLog().slice(before);
  report.forged = {
    refused: added.includes("update refused or failed"),
    reason: /update refused or failed, installed version kept \((.+)\)/.exec(added)?.[1] ?? null,
    fileUntouched: sha256(appimage) === kept,
    stillRunning: appPids().length,
  };
  await capture(null, "forged-refused");
  for (const pid of appPids()) process.kill(pid, "SIGTERM");
  const installed = report.install as { replacedByTheNewVersion: boolean; downloadedAndVerified: boolean; restartedIn: string | null };
  const forged = report.forged as { refused: boolean; reason: string | null; fileUntouched: boolean };
  verify({
    updateReplacesTheAppImage: installed.replacedByTheNewVersion && installed.downloadedAndVerified,
    restartsInTheNewVersion: installed.restartedIn === toVersion,
    // tauri-plugin-updater: "The signature was created with a different key than the one provided".
    forgedSignatureRefused: forged.refused && /signature|different key/i.test(forged.reason ?? ""),
    forgedLeavesTheFileUntouched: forged.fileUntouched,
  });
}

/** The embedded console answers: its sign-in card is drawn and the bridge reports Linux. */
async function smoke(): Promise<void> {
  const artifacts = args.artifacts ?? fail("--artifacts is required");
  // Nothing listens there: the console shows its sign-in page without an API.
  Object.assign(APP_ENV, { OPENEDBOT_API_ORIGIN: "http://127.0.0.1:9" });
  wipeAppData();
  startDriver();
  const check = async (application: string, name: string) => {
    const session = await launch(application);
    const shown = await until(session, `return !!document.querySelector('.si-card');`, 60_000, 100);
    const info = await invoke<{ platform: string; version: string; persistence: string }>(session, "shell_info");
    await capture(session, name);
    await quit(session);
    if (info.ok?.platform !== "linux") fail(`${name}: shell_info ${JSON.stringify(info)}`);
    return { signInPageMs: Math.round(shown - session.spawnedAt), shellInfo: info.ok, log: readAppLog().includes("openedbot preview") };
  };
  report.appimage = await check(prepareAppImage(artifacts, "/tmp/apps/openedbot-preview.AppImage"), "smoke-appimage");
  const installed = installDeb(onlyFile(artifacts, ".deb"));
  if (installed.code !== 0) fail(`dpkg -i failed: ${installed.out.slice(-500)}`);
  report.deb = await check(`/usr/bin/${BINARY}`, "smoke-deb");
}

try {
  report.webkitgtk = sh("pkg-config", ["--modversion", "webkit2gtk-4.1"]).out;
  report.arch = process.arch;
  if (args.scenario === "signed-in") await signedIn();
  else if (args.scenario === "memory-only") await memoryOnly();
  else if (args.scenario === "update") await update();
  else if (args.scenario === "smoke") await smoke();
  else fail(`unknown scenario ${args.scenario}`);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error instanceof Error ? error.message : error);
  log(`FAILED: ${report.error}`);
  await capture(null, "failure").catch(() => undefined);
} finally {
  report.origin = originSummary();
  report.finishedAt = new Date().toISOString();
  if (existsSync(appLog())) copyFileSync(appLog(), path.join(EVIDENCE, "preview.log"));
  writeFileSync(path.join(EVIDENCE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const child of children) child.kill("SIGTERM");
  for (const pid of appPids()) process.kill(pid, "SIGTERM");
  log(`report: ${path.join(EVIDENCE, "report.json")}`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
