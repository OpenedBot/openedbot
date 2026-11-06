import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "runtime-client-contract.ts");
const roots: string[] = [];

/** A minimal tree the contract accepts: a classified client, the factory, an API route that reads. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "runtime-client-contract-"));
  roots.push(root);
  const files: Record<string, string> = {
    "platform/hermes/src/client.ts": [
      "export class HermesClient {",
      "  constructor(config: unknown) {}",
      "  async health(): Promise<unknown> { return null; }",
      "  async createRun(input: unknown): Promise<string> { return ''; }",
      "  events(id: string) { return null; }",
      "}",
    ].join("\n"),
    "modules/runtimes/src/application/runtime-admin-client.ts": [
      "export const RUNTIME_EXECUTION_VERBS = [\"createRun\", \"events\"] as const;",
      "export const runtimeAdminClient = (config: unknown) => new HermesClient(config);",
    ].join("\n"),
    "modules/execution/src/application/runtime-client.ts": "export const createRuntimeClient = () => new HermesClient({});\n",
    "apps/api/src/routes/reads.ts": [
      "import { runtimeAdminClient } from \"@openedbot/runtimes/application/runtime-admin-client\";",
      "// new HermesClient() named in a comment only",
      "export const read = () => runtimeAdminClient({}).health();",
    ].join("\n"),
    "apps/api/tests/route.test.ts": "const client = new HermesClient({}); client.createRun({});\n",
  };
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string): { code: number; output: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime-client-contract", () => {
  test("accepts the factory, the worker's client and an API read; tests are out of scope", () => {
    const result = run(fixture());
    expect(result.output).toContain("2 verbes d'exécution");
    expect(result.code).toBe(0);
  });

  test("refuses a HermesClient built in the API, routes and scripts alike", () => {
    for (const path of ["apps/api/src/routes/compact.ts", "apps/api/scripts/seed.ts"]) {
      const root = fixture();
      write(root, path, "export const c = () => new HermesClient({});\n");
      const result = run(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain(`${path}:1`);
      expect(result.output).toContain("« new HermesClient » dans l'API");
    }
  });

  test("refuses an execution verb called, the worker's client or an execution entry point imported in the API", () => {
    const cases: Array<[string, string]> = [
      ["export const go = (client: any) => client.createRun({});\n", "verbe d'exécution « createRun »"],
      ["import { createRuntimeClient } from \"@openedbot/execution/application/runtime-client\";\n", "client du worker"],
      ["import { compactThreadNow } from \"@openedbot/conversation/application/compact-thread\";\n", "« compactThreadNow »"],
    ];
    for (const [content, message] of cases) {
      const root = fixture();
      write(root, "apps/api/src/routes/compact.ts", content);
      const result = run(root);
      expect(result.code).toBe(1);
      expect(result.output).toContain(message);
    }
  });

  test("refuses an unclassified constructor in a module", () => {
    const root = fixture();
    write(root, "modules/roster/src/application/new-host.ts", "export const c = () => new HermesClient({});\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("modules/roster/src/application/new-host.ts:1");
    expect(result.output).toContain("CONSTRUCTORS");
  });

  test("the bot host and the link enrollment probe are no longer classified constructors (S4)", () => {
    const root = fixture();
    write(root, "modules/roster/src/application/bot-host.ts", "export const c = () => new HermesClient({});\n");
    write(root, "modules/runtime-link/src/application/gateway.ts", "export const c = () => new HermesClient({});\n");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("modules/roster/src/application/bot-host.ts:1");
    expect(result.output).toContain("modules/runtime-link/src/application/gateway.ts:1");
  });

  test("refuses an unclassified HermesClient method and a verb HermesClient no longer has", () => {
    const unclassified = fixture();
    write(unclassified, "platform/hermes/src/client.ts", [
      "export class HermesClient {",
      "  async health(): Promise<unknown> { return null; }",
      "  async createRun(input: unknown): Promise<string> { return ''; }",
      "  events(id: string) { return null; }",
      "  async forkSession(id: string): Promise<void> {}",
      "}",
    ].join("\n"));
    const first = run(unclassified);
    expect(first.code).toBe(1);
    expect(first.output).toContain("HermesClient.forkSession n'est classé");

    const renamed = fixture();
    write(renamed, "platform/hermes/src/client.ts", [
      "export class HermesClient {",
      "  async health(): Promise<unknown> { return null; }",
      "  async createRun(input: unknown): Promise<string> { return ''; }",
      "}",
    ].join("\n"));
    const second = run(renamed);
    expect(second.code).toBe(1);
    expect(second.output).toContain("« events » n'est plus une méthode de HermesClient");
  });
});
