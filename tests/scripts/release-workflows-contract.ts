// Offline contract of the release workflows (.github/workflows): a release
// never depends on the Actions artifact storage, and the edge-setup release
// keeps its security separation.
//
// Why: on 2026-11-13 the tag edge-setup/v1.5.8 was built and signed, then
// failed four times at upload-artifact ("Artifact storage quota has been
// hit"): the account's artifact quota is small and recomputed hours
// late. Nothing was published and the number was burned.
//
// - No workflow downloads an artifact. An upload is a diagnostic only:
//   `if: failure()`, `continue-on-error: true`, `retention-days: 1`.
// - edge-setup-release.yml (the file name is part of the identity hosts
//   verify) hands the signed files over through the run's Actions cache:
//   one exact key (no restore-keys), `fail-on-cache-miss`, the same path
//   everywhere, and every job that publishes runs check-signed-dir.sh and
//   `make verify-signatures` after the restore and before it publishes.
// - Only the job `publish` holds the R2 token (environment edge-setup-r2);
//   only the job `verify` can sign (id-token: write), and it never sees a
//   secret.
// - Every action is pinned by a 40-hex commit SHA.
// - Pull requests come from forks: no workflow is triggered by
//   `pull_request_target` (it runs fork code with the base repository's
//   secrets and a write token), and no job of a workflow triggered by
//   `pull_request` references `secrets.`.

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; "continue-on-error"?: unknown };
type Job = { name?: string; needs?: string | string[]; if?: string; environment?: unknown; permissions?: Record<string, string> | string; steps?: Step[]; outputs?: Record<string, string>; uses?: string };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

const SIGNED_PATH = "edge-setup/signed";
const HANDOFF_KEY = "${{ needs.verify.outputs.handoff }}";

function action(step: Step): string {
  return (step.uses ?? "").split("@")[0] ?? "";
}

/** The events a workflow is triggered by, whatever form its `on:` takes (string, list or map). */
export function triggers(workflow: Workflow): string[] {
  const on = workflow.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

function stepText(step: Step): string {
  return [step.run ?? "", JSON.stringify(step.env ?? {}), JSON.stringify(step.with ?? {})].join("\n");
}

/** Every violation of the contract, in `file: job: message` form; empty when the workflows hold it. */
export function checkReleaseWorkflows(files: Record<string, string>): string[] {
  const failures: string[] = [];
  const parsed: Record<string, Workflow> = {};
  for (const [file, text] of Object.entries(files)) {
    try {
      parsed[file] = Bun.YAML.parse(text) as Workflow;
    } catch (error) {
      failures.push(`${file}: not valid YAML (${(error as Error).message})`);
    }
  }

  for (const [file, workflow] of Object.entries(parsed)) {
    const events = triggers(workflow);
    if (events.includes("pull_request_target")) failures.push(`${file}: triggered by pull_request_target, which runs fork code with secrets; use pull_request`);
    if (events.includes("pull_request")) {
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        if (/\bsecrets\./.test(JSON.stringify(job))) failures.push(`${file}: ${jobId}: references secrets. in a workflow triggered by pull_request (fork pull requests get none)`);
      }
    }
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses && !job.uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(job.uses)) failures.push(`${file}: ${jobId}: ${job.uses} is not pinned by commit SHA`);
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(step.uses)) failures.push(`${file}: ${jobId}: ${step.uses} is not pinned by commit SHA`);
        if (action(step) === "actions/download-artifact") failures.push(`${file}: ${jobId}: downloads an artifact; hand files over another way (artifact storage quota)`);
        if (action(step) === "actions/upload-artifact") {
          const where = `${file}: ${jobId}: upload-artifact`;
          if (step["continue-on-error"] !== true) failures.push(`${where} must be non-blocking (continue-on-error: true)`);
          if (!/\bfailure\(\)/.test(step.if ?? "")) failures.push(`${where} is a diagnostic: only on failure (if: failure())`);
          if (Number(step.with?.["retention-days"]) !== 1) failures.push(`${where} must be kept one day (retention-days: 1)`);
        }
      }
    }
  }

  const release = parsed["edge-setup-release.yml"];
  if (!release) {
    failures.push("edge-setup-release.yml: missing; its file name is part of the certificate identity hosts verify, never rename it");
    return failures;
  }
  const jobs = release.jobs ?? {};
  for (const id of ["verify", "publish", "github"]) if (!jobs[id]) failures.push(`edge-setup-release.yml: job ${id} is missing`);
  if (failures.length > 0) return failures;

  for (const [jobId, job] of Object.entries(jobs)) {
    const permissions = typeof job.permissions === "object" ? job.permissions : {};
    const text = JSON.stringify(job);
    if (jobId !== "publish" && (job.environment !== undefined || /secrets\./.test(text))) failures.push(`edge-setup-release.yml: ${jobId}: only the publish job holds the R2 environment and secrets`);
    if (jobId !== "verify" && permissions["id-token"] === "write") failures.push(`edge-setup-release.yml: ${jobId}: only the verify job may sign (id-token: write)`);
  }
  const verify = jobs.verify!;
  if (verify.permissions && typeof verify.permissions === "object" && verify.permissions["id-token"] !== "write") failures.push("edge-setup-release.yml: verify: signs keyless, needs id-token: write");
  if (jobs.publish!.environment !== "edge-setup-r2") failures.push("edge-setup-release.yml: publish: must run in the environment edge-setup-r2");
  if (!/steps\.v\.outputs\.handoff/.test(verify.outputs?.handoff ?? "")) failures.push("edge-setup-release.yml: verify: must output the hand-over key (handoff)");

  const verifySteps = verify.steps ?? [];
  const save = verifySteps.find((s) => action(s) === "actions/cache/save");
  if (!save) failures.push("edge-setup-release.yml: verify: saves no signed files (actions/cache/save)");
  else {
    if (save.with?.path !== SIGNED_PATH) failures.push(`edge-setup-release.yml: verify: saves ${String(save.with?.path)}, want ${SIGNED_PATH}`);
    if (save.with?.key !== "${{ steps.v.outputs.handoff }}") failures.push("edge-setup-release.yml: verify: saves under another key than its handoff output");
    const saveAt = verifySteps.indexOf(save);
    const lookup = verifySteps.slice(saveAt + 1).find((s) => action(s) === "actions/cache/restore");
    if (!lookup || lookup.with?.["lookup-only"] !== true || lookup.with?.["fail-on-cache-miss"] !== true || lookup.with?.key !== save.with?.key || lookup.with?.path !== SIGNED_PATH)
      failures.push("edge-setup-release.yml: verify: must check the saved key exists (cache/restore lookup-only + fail-on-cache-miss), cache/save only warns");
    const signAt = verifySteps.findIndex((s) => /make sign\b/.test(s.run ?? ""));
    const checkedAt = verifySteps.findIndex((s) => /make verify-signatures/.test(s.run ?? ""));
    if (signAt < 0 || checkedAt < signAt || saveAt < checkedAt) failures.push("edge-setup-release.yml: verify: must sign, then verify, then save");
  }

  for (const jobId of ["publish", "github"]) {
    const steps = jobs[jobId]!.steps ?? [];
    const restores = steps.filter((s) => action(s) === "actions/cache/restore");
    if (restores.length !== 1) {
      failures.push(`edge-setup-release.yml: ${jobId}: must restore the signed files once (actions/cache/restore)`);
      continue;
    }
    const restore = restores[0]!;
    if (restore.with?.key !== HANDOFF_KEY) failures.push(`edge-setup-release.yml: ${jobId}: restores another key than ${HANDOFF_KEY}`);
    if (restore.with?.path !== SIGNED_PATH) failures.push(`edge-setup-release.yml: ${jobId}: restores to ${String(restore.with?.path)}, want ${SIGNED_PATH}`);
    if (restore.with?.["fail-on-cache-miss"] !== true) failures.push(`edge-setup-release.yml: ${jobId}: a missing hand-over must fail (fail-on-cache-miss: true)`);
    if (restore.with?.["restore-keys"] !== undefined) failures.push(`edge-setup-release.yml: ${jobId}: no restore-keys, a restore never falls back to another key`);
    const restoredAt = steps.indexOf(restore);
    const checkedAt = steps.findIndex((s, i) => i > restoredAt && /check-signed-dir\.sh signed/.test(s.run ?? "") && /make verify-signatures[^\n]*DIR=signed/.test(s.run ?? ""));
    if (checkedAt < 0) failures.push(`edge-setup-release.yml: ${jobId}: must run check-signed-dir.sh and make verify-signatures DIR=signed after the restore`);
    if (restore.if !== undefined || (checkedAt >= 0 && steps[checkedAt]!.if !== undefined))
      failures.push(`edge-setup-release.yml: ${jobId}: the restore and the verification are unconditional`);
    const publishAt = steps.findIndex((s) => /publish-r2\.sh|publish-github\.sh/.test(stepText(s)));
    if (publishAt < 0) failures.push(`edge-setup-release.yml: ${jobId}: publishes nothing`);
    else if (checkedAt < 0 || publishAt < checkedAt) failures.push(`edge-setup-release.yml: ${jobId}: publishes before verifying the signatures`);
  }
  const publishSteps = jobs.publish!.steps ?? [];
  const tokenAt = publishSteps.findIndex((s) => /secrets\.CLOUDFLARE_R2_TOKEN/.test(stepText(s)));
  const publishCheckedAt = publishSteps.findIndex((s) => /make verify-signatures/.test(s.run ?? ""));
  if (tokenAt >= 0 && tokenAt < publishCheckedAt) failures.push("edge-setup-release.yml: publish: the R2 token reaches a step before the signatures are verified");
  const githubNeeds = ([] as string[]).concat(jobs.github!.needs ?? []);
  if (!githubNeeds.includes("publish")) failures.push("edge-setup-release.yml: github: must run after publish (R2 first)");

  const desktop = parsed["desktop-release.yml"];
  if (desktop) {
    const djobs = desktop.jobs ?? {};
    if (!/steps\.\w+\.outputs\.sums/.test(djobs.fetch?.outputs?.sums ?? "")) failures.push("desktop-release.yml: fetch: must output the verified SHA256SUMS digest (sums)");
    for (const jobId of ["mac", "linux", "release"]) {
      const steps = djobs[jobId]?.steps ?? [];
      const fetch = steps.find((s) => /fetch-r2-release\.sh "\$VERSION" r2 "\$SUMS"/.test(s.run ?? ""));
      if (!fetch || fetch.env?.SUMS !== "${{ needs.fetch.outputs.sums }}") failures.push(`desktop-release.yml: ${jobId}: must download from R2 against the SHA256SUMS the fetch job verified`);
      if (!([] as string[]).concat(djobs[jobId]?.needs ?? []).includes("fetch")) failures.push(`desktop-release.yml: ${jobId}: must need the fetch job`);
    }
  }
  return failures;
}

export async function readWorkflows(dir = `${import.meta.dir}/../../.github/workflows`): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of new Bun.Glob("*.{yml,yaml}").scanSync(dir)) files[name] = await Bun.file(`${dir}/${name}`).text();
  return files;
}

if (import.meta.main) {
  const failures = checkReleaseWorkflows(await readWorkflows());
  if (failures.length > 0) {
    for (const failure of failures) console.error(`release-workflows-contract: ${failure}`);
    console.error(`release-workflows-contract: ${failures.length} erreur(s)`);
    process.exit(1);
  }
  console.log("release-workflows-contract: OK");
}
