import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { withSseKeepalive } from "../src/application/internal-relay";

test.each(["sse", "json"])("HTTP %s cancellation does not leave a fatal unhandled rejection in Bun", async (mode) => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/runtime-link-cancel.ts"), mode], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("gateway survived 10 consumer cancellations");
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}, 5_000);

test("keepalive still propagates source failures to an active stream consumer", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const reader = withSseKeepalive(source, 500).getReader();
  const failure = new Error("upstream disconnected");
  const observed = reader.read().catch((error: unknown) => error);
  controller.error(failure);
  expect(await observed).toBe(failure);
  reader.releaseLock();
});
