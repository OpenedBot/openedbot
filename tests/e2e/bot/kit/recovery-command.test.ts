import { describe, expect, test } from "bun:test";
import { executeRecoveryCommand, parseRecoveryCommandEvidence, type RecoveryCommandEvidence } from "./recovery-command";

const target = { runtimeId: "runtime", botId: "bot", runId: "run", nonce: "bound-nonce" };
const evidence: RecoveryCommandEvidence = { schemaVersion: 1, kind: "gateway-crash-restart", nonce: target.nonce, runtimeId: target.runtimeId,
  signal: "SIGKILL", stoppedObserved: true, healthy: true,
  before: { pid: 100, startedAt: "2026-11-09T00:00:00Z" }, after: { pid: 101, startedAt: "2026-11-09T00:00:01Z" } };

describe("runtime crash driver evidence", () => {
  test("accepts only a target-bound abrupt stop with distinct newer healthy process", () => {
    expect(parseRecoveryCommandEvidence(JSON.stringify(evidence), target)).toEqual(evidence);
    for (const patch of [
      { nonce: "other" }, { runtimeId: "other" }, { schemaVersion: 2 }, { signal: "SIGTERM" },
      { stoppedObserved: false }, { healthy: false }, { before: null },
      { after: { ...evidence.after, pid: 100 } }, { after: { ...evidence.after, pid: -1 } },
      { after: { ...evidence.after, startedAt: evidence.before.startedAt } },
      { after: { ...evidence.after, startedAt: "invalid" } },
    ]) expect(() => parseRecoveryCommandEvidence(JSON.stringify({ ...evidence, ...patch }), target)).toThrow();
  });

  test("refuses malformed and oversized output without echoing its content", () => {
    for (const output of ["secret-before-json", "null", "[1]", JSON.stringify(evidence).repeat(200)]) {
      expect(() => parseRecoveryCommandEvidence(output, target)).toThrow();
    }
  });

  test("passes only explicit argv and target metadata to a local driver", async () => {
    const program = `const expected = ${JSON.stringify(evidence)}; expected.nonce = process.env.E2E_RECOVERY_NONCE;
      expected.runtimeId = process.env.E2E_RECOVERY_RUNTIME_ID;
      if (process.env.E2E_RECOVERY_BOT_ID !== 'bot' || process.env.E2E_RECOVERY_RUN_ID !== 'run') process.exit(8);
      console.log(JSON.stringify(expected));`;
    expect(await executeRecoveryCommand([process.execPath, "-e", program], target, 2_000)).toEqual(evidence);
  });

  test("does not forward application secrets from the runner's environment", async () => {
    const previous = process.env.E2E_PRIVATE_SENTINEL;
    process.env.E2E_PRIVATE_SENTINEL = "must-stay-in-parent";
    try {
      const program = `if(process.env.E2E_PRIVATE_SENTINEL)process.exit(17); console.log(${JSON.stringify(JSON.stringify(evidence))});`;
      expect(await executeRecoveryCommand([process.execPath, "-e", program], target, 2_000)).toEqual(evidence);
    } finally {
      if (previous === undefined) delete process.env.E2E_PRIVATE_SENTINEL;
      else process.env.E2E_PRIVATE_SENTINEL = previous;
    }
  });

  test("kills and reaps a hung child at the deadline", async () => {
    const started = Date.now();
    await expect(executeRecoveryCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], target, 50)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a descendant inheriting output pipes cannot hold the runner past its deadline", async () => {
    const program = `const {spawn} = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}).unref();
      setInterval(() => {}, 1000);`;
    const started = Date.now();
    await expect(executeRecoveryCommand([process.execPath, "-e", program], target, 100)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("bounds stdout and stderr, and withholds failed child diagnostics", async () => {
    await expect(executeRecoveryCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(20000))"], target, 2_000)).rejects.toThrow("16 KiB");
    await expect(executeRecoveryCommand([process.execPath, "-e", "process.stderr.write('x'.repeat(20000))"], target, 2_000)).rejects.toThrow("16 KiB");
    await expect(executeRecoveryCommand([process.execPath, "-e", "console.error('PRIVATE'); process.exit(9)"], target, 2_000)).rejects.toThrow("exit code 9; output is intentionally withheld");
  });
});
