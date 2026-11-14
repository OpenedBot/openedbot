/**
 * The load driver (`make load`): LOAD_SESSIONS operators connected over SSE,
 * LOAD_CONVERSATIONS threads talking in a closed loop for LOAD_DURATION_SECONDS
 * against the fake Hermes streaming like a model, then
 * one report from three sources: this client, the API log and the worker logs.
 *
 * One conversation loop is what the console does on a send:
 *   POST /messages (202) -> first SSE event -> first agent.message -> terminal
 *   -> POST /read once the run settled -> think -> next message.
 * Every LOAD_SNAPSHOT_INTERVAL_MS each session also reopens the roster and a
 * thread (`GET /api/bots`, `GET /history`), the reads a tab switch costs.
 * Sizing: runs in flight ~ conversations x run / (run + think). With the fake
 * streaming 30 deltas (about 3.5 s a run) and a 10 s think, 50 conversations
 * keep about 13 runs in flight; LOAD_THINK_MS=2000 saturates two workers.
 *
 * Gates: no HTTP failure, no run without a terminal, the run latency budgets at
 * p95 (admission, first runtime event, first visible text), every SSE closed
 * at the end, RSS under 70 % of the host, and under LOAD_ENFORCE_SALES_GATE=1
 * (60 minutes minimum) an RSS growth under 10 %.
 */
import { join } from "node:path";
import { RUN_LATENCY_BUDGETS_MS } from "../../platform/observability/src/run-trace";
import { readManifest, readTier, type LoadSession } from "./lib/manifest";
import { openEventStream, type OpenStream, type SseFrame } from "./lib/sse";
import { cpuSeconds, round, summarize } from "./lib/stats";
import {
  queueWakeMode, readJsonLines, summarizeHttp, summarizeRunAdmission, summarizeRunLatency,
} from "./lib/logs";
import { gateLines, ms, table, type Gate } from "./lib/report";

type Metrics = {
  totalRssBytes: number;
  hostTotalMemoryBytes: number;
  sseConnections: number;
  instances: Array<{ service: string; rssBytes: number; heapUsedBytes: number }>;
};

type RunSample = {
  runId: string;
  threadId: string;
  sentAt: number;
  acceptedMs: number;
  firstEventMs: number | null;
  firstTextMs: number | null;
  terminalMs: number | null;
  terminalType: string | null;
};

/**
 * Frames the worker produces for a run, as opposed to what the API publishes at
 * admission (the operator's message, notices): the "first runtime event" the
 * run latency budget talks about is the first of these.
 */
const RUNTIME_FRAME = /^(agent\.|tool\.|raw$|run\.completed$|run\.error$|approval\.)/;

type HttpSample = { operation: "send" | "read" | "roster" | "history"; durationMs: number; ok: boolean };

const apiUrl = (process.env.LOAD_API_URL?.trim() || "http://127.0.0.1:18790").replace(/\/+$/, "");
const manifestPath = required("LOAD_MANIFEST");
const metricsToken = required("LOAD_METRICS_TOKEN");
const tier = readTier(process.env.LOAD_SESSIONS);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 60);
const thinkMs = Number(process.env.LOAD_THINK_MS ?? 10_000);
const snapshotIntervalMs = Number(process.env.LOAD_SNAPSHOT_INTERVAL_MS ?? 5_000);
const sseConnectTimeoutMs = Number(process.env.LOAD_SSE_CONNECT_TIMEOUT_MS ?? 30_000);
const runTimeoutMs = Number(process.env.LOAD_RUN_TIMEOUT_MS ?? 60_000);
const enforceSalesGate = process.env.LOAD_ENFORCE_SALES_GATE === "1";
const logDir = process.env.LOAD_LOG_DIR?.trim() || null;
const reportPath = process.env.LOAD_REPORT?.trim() || null;
/** `name:pid,...` from run.sh: the processes whose CPU the conversation phase is charged to. */
const watchedPids = (process.env.LOAD_PIDS?.trim() || "").split(",").filter(Boolean).map((entry) => {
  const [name, pid] = entry.split(":");
  return { name: name ?? "", pid: Number(pid) };
}).filter((entry) => entry.name && Number.isInteger(entry.pid));
if (enforceSalesGate && durationSeconds < 3_600) throw new Error("The sales gate requires LOAD_DURATION_SECONDS>=3600.");

const manifest = await readManifest(manifestPath, tier);
const sessions = manifest.sessions;
const sessionIndex = new Map(sessions.map((session, index) => [session, index]));
const talkers = firstSessionPerOrganization(sessions).flatMap((session) =>
  session.threadIds.map((threadId) => ({ session, threadId })));
const conversations = Number(process.env.LOAD_CONVERSATIONS ?? Math.min(talkers.length, manifest.organizations));
if (!Number.isInteger(conversations) || conversations < 1 || conversations > talkers.length) {
  throw new Error(`LOAD_CONVERSATIONS must be between 1 and ${talkers.length} (organizations x bots).`);
}

// --- Phase 1: every session opens its organization stream ------------------
const runs = new Map<string, RunSample>();
const pendingTerminal = new Map<string, (sample: RunSample) => void>();
let framesReceived = 0;
let framesLive = 0;
let framesCommitted = 0;
const frameTypes = new Map<string, number>();
const onFrame = (frame: SseFrame) => {
  framesReceived += 1;
  if (frame.committed) framesCommitted += 1; else framesLive += 1;
  frameTypes.set(frame.type, (frameTypes.get(frame.type) ?? 0) + 1);
  const sample = runs.get(frame.event.runId);
  if (!sample) return;
  const elapsed = frame.receivedAt - sample.sentAt;
  if (RUNTIME_FRAME.test(frame.type)) sample.firstEventMs ??= elapsed;
  if (frame.type === "agent.message") sample.firstTextMs ??= elapsed;
  if (frame.type === "run.completed" || frame.type === "run.error") {
    if (sample.terminalMs === null) {
      sample.terminalMs = elapsed;
      sample.terminalType = frame.type;
      pendingTerminal.get(sample.runId)?.(sample);
    }
  }
};
const streams: OpenStream[] = [];
for (const [batchIndex, batch] of batches(sessions, 10).entries()) {
  const startedAt = performance.now();
  try {
    streams.push(...await Promise.all(batch.map((session) =>
      openEventStream({ apiUrl, headers: headers(session), connectTimeoutMs: sseConnectTimeoutMs, onFrame }))));
  } catch (error) {
    console.error(JSON.stringify({
      event: "load.sse_batch_failed", batch: batchIndex + 1, batches: Math.ceil(tier / 10),
      elapsedMs: round(performance.now() - startedAt), error: String(error), metrics: await readMetricsSafely(),
    }));
    throw error;
  }
}
let baseline = await readMetrics();
const connectionDeadline = Date.now() + 10_000;
while (baseline.sseConnections < tier && Date.now() < connectionDeadline) {
  await Bun.sleep(100);
  baseline = await readMetrics();
}
if (baseline.sseConnections < tier) throw new Error(`Expected ${tier} SSE connections, the API reports ${baseline.sseConnections}.`);
console.info(JSON.stringify({ event: "load.streams_open", sessions: tier, conversations, baselineRssBytes: baseline.totalRssBytes }));

// --- Phase 2: closed-loop conversations plus periodic snapshots ------------
const http: HttpSample[] = [];
const cpuBefore = await Promise.all(watchedPids.map((entry) => cpuSeconds(entry.pid)));
const phaseStartedAtMs = Date.now();
const deadline = phaseStartedAtMs + durationSeconds * 1_000;
let stopSnapshots = false;
const snapshotTask = snapshotIntervalMs > 0 ? runSnapshots() : Promise.resolve();
/** RSS of API + workers once a minute: a soak is judged on the curve, not on two points. */
const memorySamples: Array<{ atSeconds: number; rssBytes: number; sseConnections: number }> = [];
const memorySampler = (async () => {
  while (!stopSnapshots && Date.now() < deadline) {
    await Bun.sleep(Math.min(60_000, Math.max(1_000, deadline - Date.now())));
    const metrics = await readMetricsSafely();
    if (metrics && typeof metrics === "object" && "totalRssBytes" in metrics) {
      const sample = metrics as Metrics;
      memorySamples.push({ atSeconds: Math.round((Date.now() - phaseStartedAtMs) / 1_000), rssBytes: sample.totalRssBytes, sseConnections: sample.sseConnections });
    }
  }
})();
await Promise.all(talkers.slice(0, conversations).map((talker, index) => converse(talker.session, talker.threadId, index)));
stopSnapshots = true;
await Promise.all([snapshotTask, memorySampler]);
const phaseEndedAtMs = Date.now();
const cpuAfter = await Promise.all(watchedPids.map((entry) => cpuSeconds(entry.pid)));
/** Average cores each process used during the conversation phase. */
const cpu = Object.fromEntries(watchedPids.flatMap((entry, index) => {
  const before = cpuBefore[index];
  const after = cpuAfter[index];
  if (before === null || after === null || before === undefined || after === undefined) return [];
  return [[entry.name, round((after - before) / ((phaseEndedAtMs - phaseStartedAtMs) / 1_000) * 100) / 100]];
}));

// --- Phase 3: close everything, let the API settle, measure ---------------
for (const stream of streams) stream.controller.abort();
await Promise.allSettled(streams.map((stream) => stream.task));
await Bun.sleep(6_000);
let finalMetrics = await readMetrics();
const cleanupDeadline = Date.now() + 5_000;
while (finalMetrics.sseConnections > 0 && Date.now() < cleanupDeadline) {
  await Bun.sleep(100);
  finalMetrics = await readMetrics();
}

// --- Report ----------------------------------------------------------------
const samples = [...runs.values()];
const runIds = new Set(samples.map((sample) => sample.runId));
const missingTerminal = samples.filter((sample) => sample.terminalMs === null);
const failed = samples.filter((sample) => sample.terminalType === "run.error");
const httpFailures = http.filter((sample) => !sample.ok).length;
const client = {
  sends: samples.length,
  acceptedMs: summarize(samples.map((sample) => sample.acceptedMs)),
  firstEventMs: summarize(samples.flatMap((sample) => sample.firstEventMs === null ? [] : [sample.firstEventMs])),
  firstTextMs: summarize(samples.flatMap((sample) => sample.firstTextMs === null ? [] : [sample.firstTextMs])),
  terminalMs: summarize(samples.flatMap((sample) => sample.terminalMs === null ? [] : [sample.terminalMs])),
  http: {
    send: httpSummaryOf("send"),
    read: httpSummaryOf("read"),
    roster: httpSummaryOf("roster"),
    history: httpSummaryOf("history"),
  },
  framesReceived,
  framesLive,
  framesCommitted,
  frameTypes: Object.fromEntries([...frameTypes.entries()].sort((a, b) => b[1] - a[1])),
};

const apiLines = logDir ? await readJsonLines(join(logDir, "api.log")) : [];
const workerLogs = logDir ? [...new Bun.Glob("worker-*.log").scanSync(logDir)] : [];
const workerLines = (await Promise.all(workerLogs.map((name) => readJsonLines(join(logDir!, name))))).flat();
const httpSummary = summarizeHttp(apiLines, { fromMs: phaseStartedAtMs, toMs: phaseEndedAtMs });
const admission = summarizeRunAdmission(apiLines, runIds);
const latency = summarizeRunLatency(workerLines, runIds);
const publish = httpSummary.routes.find((route) => route.route === "/internal/events/publish");
const publishPerRun = publish && samples.length > 0 ? round(publish.count / samples.length) : null;
const rssGrowthRatio = baseline.totalRssBytes > 0 ? (finalMetrics.totalRssBytes - baseline.totalRssBytes) / baseline.totalRssBytes : 0;
const memoryRatio = finalMetrics.hostTotalMemoryBytes > 0 ? finalMetrics.totalRssBytes / finalMetrics.hostTotalMemoryBytes : 1;

const gates: Gate[] = [
  { name: "http failures", pass: httpFailures === 0 && httpSummary.errors === 0, detail: `${httpFailures} client, ${httpSummary.errors} 5xx in the API log` },
  { name: "runs settled", pass: missingTerminal.length === 0 && failed.length === 0, detail: `${missingTerminal.length} without terminal, ${failed.length} run.error, of ${samples.length}` },
  { name: `admission p95 < ${RUN_LATENCY_BUDGETS_MS.admission} ms`, pass: client.acceptedMs.p95 < RUN_LATENCY_BUDGETS_MS.admission, detail: `client 202 p95 ${client.acceptedMs.p95} ms; api.committed p95 ${admission.committedMs.p95} ms` },
  { name: `first event p95 < ${RUN_LATENCY_BUDGETS_MS.firstRuntimeEvent} ms`, pass: client.firstEventMs.p95 < RUN_LATENCY_BUDGETS_MS.firstRuntimeEvent, detail: `client ${client.firstEventMs.p95} ms; worker ${latency.firstRuntimeEventMs.p95} ms` },
  { name: `first text p95 < ${RUN_LATENCY_BUDGETS_MS.firstVisibleText} ms`, pass: client.firstTextMs.p95 < RUN_LATENCY_BUDGETS_MS.firstVisibleText, detail: `client ${client.firstTextMs.p95} ms; worker ${latency.firstVisibleTextMs.p95} ms` },
  { name: "sse closed", pass: finalMetrics.sseConnections === 0, detail: `${finalMetrics.sseConnections} left open` },
  { name: "memory < 70 % host", pass: memoryRatio < 0.7, detail: `${round(memoryRatio * 100)} % (${mib(finalMetrics.totalRssBytes)} MiB API + workers)` },
  ...(enforceSalesGate ? [{ name: "rss growth < 10 %", pass: rssGrowthRatio < 0.1, detail: `${round(rssGrowthRatio * 100)} %` }] : []),
];

const report = {
  event: "load.completed",
  sessions: tier,
  organizations: manifest.organizations,
  conversations,
  durationSeconds,
  thinkMs,
  snapshotIntervalMs,
  client,
  http: httpSummary,
  publish: publish ? { requests: publish.count, perSecond: publish.perSecond, perRun: publishPerRun, durationMs: publish.durationMs } : null,
  admission,
  latency,
  queueWake: workerLines.length > 0 ? queueWakeMode(workerLines) : "unknown",
  cpu,
  memory: {
    baselineRssBytes: baseline.totalRssBytes,
    finalRssBytes: finalMetrics.totalRssBytes,
    rssGrowthPercent: round(rssGrowthRatio * 100),
    memoryPercent: round(memoryRatio * 100),
    finalInstances: finalMetrics.instances,
    samples: memorySamples,
  },
  finalSseConnections: finalMetrics.sseConnections,
  missingTerminal: missingTerminal.map((sample) => sample.runId),
  gates,
};
if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2));
console.info(JSON.stringify(report));
printReport();
if (gates.some((gate) => !gate.pass)) process.exit(1);

// --- Scenario pieces --------------------------------------------------------

async function converse(session: LoadSession, threadId: string, index: number): Promise<void> {
  // Spread the first sends over one think time so the loops do not stay in lockstep.
  await Bun.sleep((index * 97) % Math.max(1, thinkMs));
  let turn = 0;
  while (Date.now() < deadline) {
    const sample = await send(session, threadId, `load turn ${turn} on ${threadId.slice(0, 8)}`);
    turn += 1;
    if (!sample) {
      await Bun.sleep(thinkMs);
      continue;
    }
    await awaitTerminal(sample);
    if (sample.terminalMs !== null) await markRead(session, threadId);
    await Bun.sleep(thinkMs);
  }
}

async function send(session: LoadSession, threadId: string, input: string): Promise<RunSample | null> {
  const sentAt = performance.now();
  const response = await fetch(`${apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: headers(session, { "Content-Type": "application/json" }),
    body: JSON.stringify({ input, attachments: [] }),
  });
  const acceptedMs = performance.now() - sentAt;
  const body = await response.json().catch(() => null) as { runId?: unknown } | null;
  const ok = response.status === 202 && typeof body?.runId === "string";
  http.push({ operation: "send", durationMs: acceptedMs, ok });
  if (!ok) return null;
  const sample: RunSample = {
    runId: body!.runId as string, threadId, sentAt, acceptedMs, firstEventMs: null, firstTextMs: null, terminalMs: null, terminalType: null,
  };
  runs.set(sample.runId, sample);
  return sample;
}

function awaitTerminal(sample: RunSample): Promise<void> {
  if (sample.terminalMs !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingTerminal.delete(sample.runId); resolve(); }, runTimeoutMs);
    pendingTerminal.set(sample.runId, () => { clearTimeout(timer); pendingTerminal.delete(sample.runId); resolve(); });
  });
}

async function markRead(session: LoadSession, threadId: string): Promise<void> {
  const startedAt = performance.now();
  const response = await fetch(`${apiUrl}/api/threads/${threadId}/read`, {
    method: "POST",
    headers: headers(session, { "Content-Type": "application/json" }),
    body: JSON.stringify({ readThrough: new Date().toISOString() }),
  });
  await response.arrayBuffer();
  http.push({ operation: "read", durationMs: performance.now() - startedAt, ok: response.status === 204 });
}

async function runSnapshots(): Promise<void> {
  // Each session reopens the app once per interval, staggered across the interval.
  const stagger = snapshotIntervalMs / Math.max(1, sessions.length);
  const tasks = sessions.map(async (session, index) => {
    await Bun.sleep(index * stagger);
    while (!stopSnapshots && Date.now() < deadline) {
      await snapshot(session, "roster", `/api/bots`);
      await snapshot(session, "history", `/api/threads/${session.threadIds[index % session.threadIds.length]}/history`);
      await Bun.sleep(snapshotIntervalMs);
    }
  });
  await Promise.all(tasks);
}

async function snapshot(session: LoadSession, operation: "roster" | "history", path: string): Promise<void> {
  const startedAt = performance.now();
  const response = await fetch(`${apiUrl}${path}`, { headers: headers(session) });
  await response.arrayBuffer();
  http.push({ operation, durationMs: performance.now() - startedAt, ok: response.ok });
}

// --- Plumbing ---------------------------------------------------------------

async function readMetrics(): Promise<Metrics> {
  const response = await fetch(`${apiUrl}/internal/metrics`, { headers: { Authorization: `Bearer ${metricsToken}` } });
  if (!response.ok) throw new Error(`Metrics failed with HTTP ${response.status}.`);
  return await response.json() as Metrics;
}

async function readMetricsSafely(): Promise<unknown> {
  try { return await readMetrics(); } catch (error) { return String(error); }
}

/**
 * Each session is one operator on their own address, as behind the production
 * proxy (`API_TRUST_PROXY=1`): the per-IP rate rules (`GET /api/events*` is 30
 * a minute) must see the bench as a crowd, not as one client.
 */
function headers(session: LoadSession, extra: Record<string, string> = {}): Record<string, string> {
  const index = sessionIndex.get(session) ?? 0;
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "X-OpenedBot-Organization": session.organizationId,
    "X-Forwarded-For": `10.${Math.floor(index / 65_025)}.${Math.floor(index / 255) % 255}.${1 + (index % 255)}`,
    ...extra,
  };
}

function firstSessionPerOrganization(values: LoadSession[]): LoadSession[] {
  const seen = new Set<string>();
  return values.filter((session) => !seen.has(session.organizationId) && seen.add(session.organizationId));
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function httpSummaryOf(operation: HttpSample["operation"]) {
  return summarize(http.filter((sample) => sample.operation === operation).map((sample) => sample.durationMs));
}

function mib(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

function printReport(): void {
  const lines: string[] = [];
  lines.push(`Load bench: ${tier} sessions, ${conversations} conversations, ${durationSeconds} s, think ${thinkMs} ms`);
  lines.push(table(
    ["Stage (ms, p50 / p95 / max)", "Client", "Server"],
    [
      ["202 accepted / api.committed", ms(client.acceptedMs), ms(admission.committedMs)],
      ["queued (created -> claimed)", "", ms(latency.queuedMs)],
      ["first runtime event", ms(client.firstEventMs), ms(latency.firstRuntimeEventMs)],
      ["first visible text", ms(client.firstTextMs), ms(latency.firstVisibleTextMs)],
      ["terminal", ms(client.terminalMs), ms(latency.terminalMs)],
    ],
  ));
  lines.push(`runs: ${samples.length} sent, ${latency.runs} traced by the workers, ${admission.runs} admitted by the API, queue wake: ${report.queueWake}, event replay: ${latency.eventReplay}`);
  if (Object.keys(latency.spans).length > 0) {
    lines.push(table(
      ["Worker span (ms, p50 / p95 / max)", "Value"],
      Object.entries(latency.spans).sort((a, b) => b[1].p95 - a[1].p95).map(([name, summary]) => [name, ms(summary)]),
    ));
  }
  if (httpSummary.routes.length > 0) {
    lines.push(table(
      ["API route", "Requests", "req/s", "5xx", "ms p50 / p95 / max"],
      httpSummary.routes.map((route) => [route.route, route.count, route.perSecond, route.errors, ms(route.durationMs)]),
    ));
    if (publish) lines.push(`internal publish hints: ${publish.count} (${publish.perSecond}/s, ${publishPerRun} per run) over ${httpSummary.windowSeconds} s`);
  } else {
    lines.push("API log not read (LOAD_LOG_DIR unset or empty): route table and run.admission unavailable.");
  }
  lines.push(`memory: ${mib(baseline.totalRssBytes)} -> ${mib(finalMetrics.totalRssBytes)} MiB (${report.memory.rssGrowthPercent} %), ${report.memory.memoryPercent} % of host; frames received: ${framesReceived}, ${framesLive} live + ${framesCommitted} committed (${Object.entries(client.frameTypes).map(([type, count]) => `${type} ${count}`).join(", ")}); p95 client http: send ${client.http.send.p95} ms, read ${client.http.read.p95} ms, roster ${client.http.roster.p95} ms, history ${client.http.history.p95} ms`);
  if (memorySamples.length > 1) {
    lines.push(`rss curve (MiB at s): ${memorySamples.map((sample) => `${mib(sample.rssBytes)}@${sample.atSeconds}`).join(" ")}`);
  }
  if (Object.keys(cpu).length > 0) {
    lines.push(`cpu (average cores over the conversation phase): ${Object.entries(cpu).map(([name, cores]) => `${name} ${cores}`).join(", ")}`);
  }
  lines.push(gateLines(gates));
  console.info(lines.join("\n"));
}

