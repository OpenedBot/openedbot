/**
 * Bot e2e runner: plays scenarios against the runtime really linked to the
 * local stack, then writes `report.json` and a self-contained `report.html`.
 *
 *   E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts [scenario...] [options]
 *
 * Suites:    p0, p1, acceptance (both), all (legacy + acceptance).
 * Individual scenarios and prerequisites: tests/e2e/bot/README.md.
 * Options:   --samples N (greeting, model-reset)   --messages N (fast-path)
 *            --label L   --out DIR    --keep   --purge-early   --locale en
 *            --defer-cleanup (bench: purge all bots at the end, in parallel)
 * Env:       E2E_PROVIDER / E2E_MODEL / E2E_REASONING_EFFORT pin the model;
 *            E2E_API_URL, E2E_RUN_TIMEOUT_MS, E2E_CLEANUP_TIMEOUT_MS.
 *
 * Every bot a scenario creates is purged before exit, and a purge counts only
 * once its host cleanup succeeded. Exit code 1 when a scenario or a cleanup
 * failed, incomplete or reserved; the report is written either way.
 */
import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BotLab } from "./kit/bots";
import { readConfig, type E2eConfig } from "./kit/config";
import { EventStream } from "./kit/events";
import { inspectionBeforePurge } from "./kit/failure-inspection";
import { renderReport } from "./kit/html";
import { ScenarioRecorder, StepFailed, worst, type RunReport, type ScenarioResult } from "./kit/report";
import type { Scenario } from "./kit/scenario";
import { Session, type ModelChoice } from "./kit/session";
import { enforceAcceptanceTarget, pickScenarios } from "./kit/scenarios";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `e2e.${event}`, ...fields }));
}

async function gitSha(): Promise<string | null> {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const sha = result.stdout.toString().trim();
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=normal"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return sha ? `${sha}${dirty ? " (modifié)" : ""}` : null;
}

async function playScenario(scenario: Scenario, context: { lab: BotLab; session: Session; config: E2eConfig; model: ModelChoice }): Promise<ScenarioResult> {
  const rec = new ScenarioRecorder(context.config.strict, (step) => log("step_finished", { scenario: scenario.id, name: step.name, status: step.status, ms: step.ms, note: step.note }));
  const started = performance.now();
  let error: string | null = null;
  log("scenario_started", { scenario: scenario.id });
  try {
    await scenario.run({ ...context, rec });
  } catch (failure) {
    if (!(failure instanceof StepFailed)) error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    // Inspection is optional and never changes the failed verdict. Its own
    // failures still reach the helper's finally, which always purges profiles.
    await inspectionBeforePurge(Boolean(error) || worst(rec.steps.map((step) => step.status)) === "fail", {
      scenario: scenario.id, runtime: context.session.runtime.id, labTag: context.lab.tag,
      outDir: context.config.outDir, milliseconds: context.config.failureInspectionMs, caseKey: rec,
    }, () => context.lab.purgeAll());
  }
  const status = error ? "fail" : worst(rec.steps.map((step) => step.status));
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    status,
    ms: Math.round(performance.now() - started),
    steps: rec.steps,
    bench: rec.bench,
    error,
  };
  log("scenario_finished", { scenario: scenario.id, status, ms: result.ms, steps: rec.steps.map((step) => `${step.status}:${step.name}`) });
  return result;
}

async function main(): Promise<number> {
  const config = readConfig(Bun.argv.slice(2), process.env);
  const scenarios = pickScenarios(config.scenarios);
  enforceAcceptanceTarget(config, scenarios);
  const report: RunReport = {
    label: config.label,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "pass",
    apiUrl: config.apiUrl,
    gitSha: await gitSha(),
    runtime: null,
    model: null,
    options: { scenarios: scenarios.map((scenario) => scenario.id).join(","), samples: config.samples, messages: config.messages, keep: config.keep, purgeEarly: config.purgeEarly, deferCleanup: config.deferCleanup, locale: config.locale },
    scenarios: [],
    cleanup: [],
    error: null,
  };
  const db = new SQL(config.databaseUrl);
  let session: Session | null = null;
  let events: EventStream | null = null;
  let lab: BotLab | null = null;
  try {
    session = await Session.open(config, process.env);
    report.runtime = { id: session.runtime.id, name: session.runtime.name, features: session.runtime.linkFeatures ?? [],
      hermesVersion: session.runtime.link?.hermesUpdate?.current ?? null, connectorVersion: session.runtime.link?.connector?.version ?? null };
    const identities = await db<Array<{ role: string; visible: boolean }>>`
      select current_user as role, exists(select 1 from runtimes where id = ${session.runtime.id}
        and organization_id = ${session.organizationId}) as visible`;
    if (!identities[0]?.visible) throw new Error("The evidence database cannot see the API runtime. Use WORKER_DATABASE_URL for the same dev stack; no bot was created.");
    report.options.strict = config.strict;
    report.options.browserTarget = config.browserTarget;
    report.options.exclusiveRuntime = config.exclusiveRuntime;
    const model = await session.chooseModel(config);
    report.model = model;
    log("run_started", { runtime: session.runtime.name, provider: model.provider, model: model.model, scenarios: report.options.scenarios });
    const opened = session;
    events = new EventStream(config.apiUrl, () => opened.streamHeaders());
    await events.start();
    lab = new BotLab(session, db, events, config);
    for (const scenario of scenarios) report.scenarios.push(await playScenario(scenario, { lab, session, config, model }));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await lab?.purgeAll();
    const closed = await Promise.allSettled([events?.stop(), session?.close(), db.close()]);
    const failures = closed.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (failures.length) report.error = [report.error, ...failures].filter(Boolean).join("; ");
  }
  if (events) {
    report.options.streamReconnects = Math.max(0, events.connections - 1);
    report.options.streamGaps = events.gaps;
    report.options.streamMalformed = events.malformed;
    report.options.streamDuplicates = events.duplicates;
    if (events.gaps || events.malformed || events.fatalError) report.error = [report.error, events.fatalError ?? "SSE evidence is incomplete: stream gaps or malformed frames."].filter(Boolean).join("; ");
  }
  report.cleanup = lab?.purges ?? [];
  report.finishedAt = new Date().toISOString();
  const cleanupFailed = report.cleanup.some((entry) => entry.cleanup !== "succeeded" && entry.cleanup !== "none");
  report.status = report.error || cleanupFailed ? "fail" : worst(report.scenarios.map((scenario) => scenario.status));
  const outDir = resolve(config.outDir);
  mkdirSync(outDir, { recursive: true });
  await Bun.write(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(`${outDir}/report.html`, await renderReport(report));
  log("run_finished", { status: report.status, report: `${outDir}/report.html`, error: report.error });
  return report.status === "pass" ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
