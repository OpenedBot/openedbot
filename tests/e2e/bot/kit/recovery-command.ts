import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";

/** Explicit operator driver only. Never invent a host, shell, signal command or credential. */
export type RecoveryCommandTarget = { runtimeId: string; botId: string; runId: string; nonce: string };
export type RecoveryProcess = { pid: number; startedAt: string };
export type RecoveryCommandEvidence = {
  schemaVersion: 1;
  kind: "gateway-crash-restart";
  nonce: string;
  runtimeId: string;
  signal: "SIGKILL";
  stoppedObserved: true;
  healthy: true;
  before: RecoveryProcess;
  after: RecoveryProcess;
};

const MAX_OUTPUT = 16_384;
function processEvidence(value: unknown): value is RecoveryProcess {
  if (!value || typeof value !== "object") return false;
  const process = value as Partial<RecoveryProcess>;
  return Number.isSafeInteger(process.pid) && Number(process.pid) > 0
    && typeof process.startedAt === "string" && Number.isFinite(Date.parse(process.startedAt));
}

/** Operator-provided attestation, cross-checked against independent gateway API evidence by the scenario. */
export function parseRecoveryCommandEvidence(output: string, target: RecoveryCommandTarget): RecoveryCommandEvidence {
  if (new TextEncoder().encode(output).length > MAX_OUTPUT) throw new Error("Recovery driver output exceeded 16 KiB.");
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Recovery driver must emit one JSON evidence document."); }
  if (!value || typeof value !== "object") throw new Error("Recovery driver evidence must be an object.");
  const evidence = value as Partial<RecoveryCommandEvidence>;
  if (evidence.schemaVersion !== 1 || evidence.kind !== "gateway-crash-restart" || evidence.nonce !== target.nonce
    || evidence.runtimeId !== target.runtimeId || evidence.signal !== "SIGKILL" || evidence.stoppedObserved !== true
    || evidence.healthy !== true || !processEvidence(evidence.before) || !processEvidence(evidence.after)
    || evidence.before.pid === evidence.after.pid || Date.parse(evidence.after.startedAt) <= Date.parse(evidence.before.startedAt)) {
    throw new Error("Recovery driver did not prove the requested target, abrupt stop and distinct healthy process.");
  }
  return evidence as RecoveryCommandEvidence;
}

/** Bounded output and time; kill and reap even when the child hangs or floods its pipes. */
export async function executeRecoveryCommand(argv: string[], target: RecoveryCommandTarget, timeoutMs: number): Promise<RecoveryCommandEvidence> {
  if (!argv.length || argv.some((part) => typeof part !== "string" || !part)) throw new Error("Recovery driver argv is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Recovery driver timeout must be positive.");
  const processGroup = process.platform !== "win32";
  // A fault driver needs process/SSH coordinates, not the application's DB,
  // model-provider or internal relay credentials inherited by the runner.
  const driverEnv = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "TMPDIR", "SystemRoot", "ComSpec", "PATHEXT", "windir"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  // Environment filtering must also prevent Bun's automatic .env loading.
  const childArgs = /^bun(?:\.exe)?$/.test(basename(argv[0]!)) ? ["--no-env-file", ...argv.slice(1)] : argv.slice(1);
  const child = spawn(argv[0]!, childArgs, {
    env: { ...driverEnv, E2E_RECOVERY_NONCE: target.nonce, E2E_RECOVERY_RUNTIME_ID: target.runtimeId,
      E2E_RECOVERY_BOT_ID: target.botId, E2E_RECOVERY_RUN_ID: target.runId },
    stdio: ["ignore", "pipe", "pipe"], detached: processGroup,
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new Error("Recovery driver could not be launched.")));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Recovery driver timed out after ${timeoutMs} ms.`)), timeoutMs);
  });
  const read = async (stream: Readable, keep: boolean): Promise<string> => {
    const decoder = new TextDecoder();
    let bytes = 0, output = "";
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT) throw new Error("Recovery driver output exceeded 16 KiB.");
      if (keep) output += decoder.decode(chunk, { stream: true });
    }
    return output + (keep ? decoder.decode() : "");
  };
  try {
    const [output, , code] = await Promise.race([
      Promise.all([read(child.stdout, true), read(child.stderr, false), exited]), deadline,
    ]);
    if (code !== 0) throw new Error(`Recovery driver failed with exit code ${code}; output is intentionally withheld.`);
    return parseRecoveryCommandEvidence(output, target);
  } finally {
    clearTimeout(timer);
    // Drivers can spawn children inheriting their pipes. Killing only the
    // parent would leave both those processes and the readers alive forever.
    if (child.pid) {
      try { process.kill(processGroup ? -child.pid : child.pid, "SIGKILL"); } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : null;
        // macOS can reap the leader before JavaScript receives its exit
        // callback, then return EPERM for the vanished process group.
        const alreadyExited = process.platform === "darwin" && code === "EPERM"
          && await Promise.race([exited.then(() => true), Bun.sleep(100).then(() => false)]);
        if (code !== "ESRCH" && !alreadyExited) throw error;
      }
    }
    await exited;
  }
}
