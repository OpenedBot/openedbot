import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createWorkerRegistry } from "../src/infrastructure/worker-registry";

describe("worker registry shutdown", () => {
  test("releases every active run state, including an approval wait", async () => {
    const statements: string[] = [];
    const query = (async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return [];
    }) as unknown as SQL;
    (query as unknown as { close(options: { timeout: number }): Promise<void> }).close = async () => undefined;

    await createWorkerRegistry(query, "worker-test").releaseLeasesAndClose();

    expect(statements[0]).toContain("status in ('starting','running','awaiting_approval')");
    expect(statements[1]).toContain("status in ('starting','running','awaiting_approval')");
  });
});
