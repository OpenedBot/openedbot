/**
 * Bot e2e runner: plays scenarios against the runtime really linked to the
 * local stack, then writes `report.json` and a self-contained `report.html`.
 *
 *   E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/bot/run.ts [scenario...] [options]
 *
 * Scenarios: lifecycle (default), greeting, fast-path, coordination,
 *            model-reset, permissions, all.
 * Options:   --samples N (greeting, model-reset)   --messages N (fast-path)
 *            --label L   --out DIR    --keep   --purge-early   --locale en
 *            --defer-cleanup (bench: purge all bots at the end, in parallel)
 * Env:       E2E_PROVIDER / E2E_MODEL / E2E_REASONING_EFFORT pin the model;
 *            E2E_API_URL, E2E_RUN_TIMEOUT_MS, E2E_CLEANUP_TIMEOUT_MS.
 *
 * Every bot a scenario creates is purged before exit, and a purge counts only
 * once its host cleanup succeeded. Exit code 1 when a scenario or a cleanup
 * failed; the report is written either way.
 */
import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BotLab } from "./kit/bots";
import { ConfigError, readConfig, type E2eConfig } from "./kit/config";
import { EventStream } from "./kit/events";
import { renderReport } from "./kit/html";
import { ScenarioRecorder, StepFailed, worst, type RunReport, type ScenarioResult } from "./kit/report";
import type { Scenario } from "./kit/scenario";
import { Session, type ModelChoice } from "./kit/session";
import { coordination } from "./scenarios/coordination";
import { fastPath } from "./scenarios/fast-path";
import { greeting } from "./scenarios/greeting";
import { lifecycle } from "./scenarios/lifecycle";
import { modelReset } from "./scenarios/model-reset";
import { permissions } from "./scenarios/permissions";

const SCENARIOS: Scenario[] = [lifecycle, greeting, fastPath, coordination, modelReset, permissions];

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `e2e.${event}`, ...fields }));
}

function pick(names: string[]): Scenario[] {
  if (names.includes("all")) return SCENARIOS;
  return names.map((name) => {
    const found = SCENARIOS.find((scenario) => scenario.id === name);
    if (!found) throw new ConfigError(`Unknown scenario "${name}". Known: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}, all.`);
    return found;
  });
}

async function gitSha(): Promise<string | null> {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const sha = result.stdout.toString().trim();
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return sha ? `${sha}${dirty ? " (modifié)" : ""}` : null;
}

async function playScenario(scenario: Scenario, context: { lab: BotLab; session: Session; config: E2eConfig; model: ModelChoice }): Promise<ScenarioResult> {
  const rec = new ScenarioRecorder();
  const started = performance.now();
  let error: string | null = null;
  log("scenario_started", { scenario: scenario.id });
  try {
    await scenario.run({ ...context, rec });
  } catch (failure) {
    if (!(failure instanceof StepFailed)) error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    // A scenario never leaves its bots to the next one.
    await context.lab.purgeAll();
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
  const scenarios = pick(config.scenarios);
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
    report.runtime = { id: session.runtime.id, name: session.runtime.name, features: session.runtime.linkFeatures ?? [] };
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
    await events?.stop();
    await session?.close();
    await db.close();
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
  return report.status === "fail" ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
