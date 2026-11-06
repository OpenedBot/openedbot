// G4 of the D0 baseline (d0-baseline.ts): one long answer streamed through
// the real composer, with frames and long animation frames recorded while
// the text grows. The run's status comes from the API, never from the DOM.

import type { Page } from "playwright";

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))]!;
};

// Installed before the prompt is sent. Besides frames and long frames, it
// follows the ANSWER itself: the newest `[data-assistant-response]` that did
// not exist before sending. The whole thread's text is no measure: past 40
// turns the timeline unmounts the oldest turn while the answer grows
// (lib/thread/thread-window.ts). Growth is timestamped in the page, by a
// MutationObserver, so an answer that lands in one burst between two polls
// still has a real start and end.
const STREAM_PROBE = `(() => {
  const origin = performance.timeOrigin;
  const known = new WeakSet(document.querySelectorAll("[data-assistant-response]"));
  const state = { longTasks: [], loafs: [], frames: [], running: true, answerChars: 0, firstTextAt: null, lastGrowthAt: null };
  window.__d0Stream = state;
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) state.longTasks.push([origin + e.startTime, e.duration]); }).observe({ type: "longtask", buffered: false }); } catch {}
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) state.loafs.push([origin + e.startTime, e.duration]); }).observe({ type: "long-animation-frame", buffered: false }); } catch {}
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

export async function openBotThread(page: Page, botId: string): Promise<void> {
  await page.locator(`a[href*="/bot/${botId}"]`).first().click();
  await page.locator("[data-thread-messages]").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("[data-thread-composer] textarea").first().waitFor({ state: "visible", timeout: 30_000 });
  await Bun.sleep(1_500);
}

type RunRow = { id: string; status: string; createdAt: string; error?: string | null };
const TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);

const TRIAL_DEADLINE_MS = 8 * 60_000;

/**
 * Sends the long prompt through the real composer, then watches the run by
 * the API (its status is the source of truth, not the DOM) and the answer's
 * growth in the page (STREAM_PROBE). Frames and long frames are kept only
 * inside the window where the answer was actually growing.
 */

export async function measureStreaming(page: Page, api: { base: string; cookie: string; threadId: string }) {
  const deadline = Date.now() + TRIAL_DEADLINE_MS;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`streaming trial exceeded ${TRIAL_DEADLINE_MS / 60_000} min`);
    return left;
  };
  const textLength = () => page.evaluate(() => document.querySelector("[data-thread-messages]")?.textContent?.length ?? 0);
  const latestRun = async (since: number): Promise<RunRow | null> => {
    // One signal covers the request and the body: a stalled API cannot hold
    // the trial past its deadline.
    const signal = AbortSignal.timeout(Math.min(15_000, remaining()));
    const response = await fetch(`${api.base}/api/threads/${api.threadId}`, { headers: { cookie: api.cookie }, signal });
    const thread = await response.json() as { runs?: RunRow[] };
    const fresh = (thread.runs ?? []).filter((run) => Date.parse(run.createdAt) >= since - 2_000);
    return fresh.at(-1) ?? null;
  };
  await page.evaluate(STREAM_PROBE);
  const composer = page.locator("[data-thread-composer] textarea").first();
  await composer.fill(STREAM_PROMPT);
  const before = await textLength();
  const sentAt = Date.now();
  await composer.press("Enter");
  type Probe = { longTasks: Array<[number, number]>; loafs: Array<[number, number]>; frames: Array<[number, number]>; running: boolean; answerChars: number; firstTextAt: number | null; lastGrowthAt: number | null };
  const readProbe = () => page.evaluate(() => {
    const state = (window as unknown as { __d0Stream: { answerChars: number; firstTextAt: number | null; lastGrowthAt: number | null } }).__d0Stream;
    return { answerChars: state.answerChars, firstTextAt: state.firstTextAt, lastGrowthAt: state.lastGrowthAt };
  });
  let run: RunRow | null = null;
  let settled = false;
  while (!settled) {
    await Bun.sleep(Math.min(250, remaining()));
    run = await latestRun(sentAt);
    const growth = await readProbe();
    const quietSince = growth.lastGrowthAt ?? sentAt;
    if (run && TERMINAL.has(run.status) && Date.now() - quietSince > 2_000) settled = true;
  }
  const probe = await page.evaluate(() => {
    const state = (window as unknown as { __d0Stream: { running: boolean } }).__d0Stream;
    state.running = false;
    return state;
  }) as Probe;
  const firstTextAt = probe.firstTextAt;
  // The frames that paint the last growth come right after it: keep 250 ms
  // past it, so a one-burst answer still has its rendering measured.
  const doneAt = (probe.lastGrowthAt ?? sentAt) + 250;
  // An interval counts in a window when it OVERLAPS it, not when its
  // callback lands inside: a stall right after the last growth ends in a
  // frame whose callback comes after `doneAt`, and must still be counted.
  // Frames are [callback - delta, callback]; long tasks and long animation
  // frames are [start, start + duration].
  const overlaps = (start: number, end: number, from: number, to: number) => start < to && end > from;
  const streamFrom = firstTextAt ?? Number.POSITIVE_INFINITY;
  const preTo = firstTextAt ?? doneAt;
  const frames = probe.frames.filter(([at, delta]) => overlaps(at - delta, at, streamFrom, doneAt)).map(([, delta]) => delta);
  // Same window as the frames: from the first visible text to the end of
  // growth. What happens between Enter and the first text (send, the
  // "thinking" line) is reported apart.
  const inWindow = (entries: Array<[number, number]>, from: number, to: number) =>
    entries.filter(([start, duration]) => overlaps(start, start + duration, from, to)).map(([, duration]) => duration);
  const longTasks = inWindow(probe.longTasks, streamFrom, doneAt);
  const loafs = inWindow(probe.loafs, streamFrom, doneAt);
  const preLongTasks = inWindow(probe.longTasks, sentAt, preTo);
  const preLoafs = inWindow(probe.loafs, sentAt, preTo);
  const framesMs = frames.reduce((sum, delta) => sum + delta, 0);
  return {
    runStatus: run?.status ?? null,
    runError: run?.error ? String(run.error).slice(0, 160) : null,
    completed: run?.status === "completed" && firstTextAt !== null,
    timeToFirstTextMs: firstTextAt ? Math.round(firstTextAt - sentAt) : null,
    streamMs: firstTextAt && probe.lastGrowthAt ? Math.round(probe.lastGrowthAt - firstTextAt) : 0,
    totalMs: Math.round((probe.lastGrowthAt ?? sentAt) - sentAt),
    answerChars: probe.answerChars,
    promptCharsBefore: before,
    longTasksOver50ms: longTasks.length,
    longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
    longTaskTotalMs: Math.round(longTasks.reduce((sum, d) => sum + d, 0)),
    longAnimationFrames: loafs.length,
    longAnimationFrameMaxMs: loafs.length ? Math.round(Math.max(...loafs)) : 0,
    preStream: {
      longTasksOver50ms: preLongTasks.length,
      longTaskMaxMs: preLongTasks.length ? Math.round(Math.max(...preLongTasks)) : 0,
      longAnimationFrames: preLoafs.length,
      longAnimationFrameMaxMs: preLoafs.length ? Math.round(Math.max(...preLoafs)) : 0,
    },
    fpsMean: frames.length ? Math.round((frames.length / (framesMs / 1000)) * 10) / 10 : null,
    fpsP5: frames.length ? Math.round(percentile(frames.map((d) => 1000 / d), 5)! * 10) / 10 : null,
    frameMaxMs: frames.length ? Math.round(Math.max(...frames)) : null,
  };
}
