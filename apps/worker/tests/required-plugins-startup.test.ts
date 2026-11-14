import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * OPENEDBOT_REQUIRED_PLUGINS at the real entry point: a worker told it needs
 * the plug-in `audit` and given none exits non-zero before touching the
 * database, with one log line naming the missing id. (The pool connects
 * lazily: the unreachable URL below is never dialled.)
 */
const ENTRY = join(import.meta.dir, "../src/index.ts");

describe("worker startup with OPENEDBOT_REQUIRED_PLUGINS", () => {
  test("a required plug-in that is not loaded stops the worker, and the log names it", async () => {
    const run = Bun.spawn(["bun", ENTRY], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        OPENEDBOT_ENV: "development",
        WORKER_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
        RUNTIME_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        OPENEDBOT_PLUGINS: "",
        OPENEDBOT_REQUIRED_PLUGINS: "audit,permissions",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => run.kill(), 20_000);
    const [code, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    clearTimeout(timer);
    const output = `${out}${err}`;
    expect(code).not.toBe(0);
    expect(output).toContain("worker.required_plugins_missing");
    expect(output).toContain("OPENEDBOT_REQUIRED_PLUGINS requires plug-in(s) that are not loaded: audit, permissions.");
    expect(output).not.toContain("worker.started");
  }, 30_000);
});
