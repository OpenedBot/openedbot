import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("web Vite API proxy", () => {
  test("relays the Hermes connector WebSocket through the public dev origin", () => {
    const vite = readFileSync(join(webRoot, "vite.config.ts"), "utf8");

    expect(vite).toMatch(
      /const apiProxy = \{[\s\S]*"\/api": \{[\s\S]*ws: true,[\s\S]*timeout: 0,[\s\S]*proxyTimeout: 0/,
    );
    expect(vite).toContain("target: apiProxyTarget(env)");
  });
});
