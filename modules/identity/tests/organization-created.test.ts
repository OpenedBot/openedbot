import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@openedbot/platform-observability";
import type { Db } from "@openedbot/platform-db";
import { announceOrganizationCreated, installOrganizationCreatedListener } from "../src/application/organization-created";
import { createOrganization } from "../src/sql/accounts";

afterEach(() => installOrganizationCreatedListener(null));

/** A database whose transactions always commit, recording each statement. */
function committingDb(statements: string[], order: string[]) {
  const tx = async (strings: TemplateStringsArray) => { statements.push(strings.join("?").replace(/\s+/g, " ").trim()); return []; };
  return { begin: async (callback: (t: typeof tx) => Promise<unknown>) => { const result = await callback(tx); order.push("commit"); return result; } } as unknown as Db;
}

describe("announceOrganizationCreated", () => {
  test("without a listener (solo) it does nothing", async () => {
    await announceOrganizationCreated("org-1");
  });

  test("idempotent: one call per organization, even when announced twice", async () => {
    const calls: string[] = [];
    installOrganizationCreatedListener(async (id) => { calls.push(id); });
    await announceOrganizationCreated("org-1");
    await announceOrganizationCreated("org-1");
    await announceOrganizationCreated("org-2");
    expect(calls).toEqual(["org-1", "org-2"]);
  });

  test("a listener that throws, rejects or hangs is logged and never propagates", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      installOrganizationCreatedListener(() => { throw new Error("sync boom"); });
      await announceOrganizationCreated("org-sync");
      installOrganizationCreatedListener(async () => { throw new Error("async boom"); });
      await announceOrganizationCreated("org-async");
      installOrganizationCreatedListener(() => new Promise(() => undefined), { timeoutMs: 20 });
      await announceOrganizationCreated("org-hang");
      const events = warn.mock.calls.map(([fields]) => fields as unknown as { event: string; organizationId: string; error: string });
      expect(events.map((event) => [event.event, event.organizationId, event.error])).toEqual([
        ["identity.organization_created_listener_failed", "org-sync", "sync boom"],
        ["identity.organization_created_listener_failed", "org-async", "async boom"],
        ["identity.organization_created_listener_failed", "org-hang", "timed out after 20 ms"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createOrganization announces after the commit", () => {
  test("the listener runs once, after the transaction, and a failing listener changes nothing", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const statements: string[] = [];
      const order: string[] = [];
      installOrganizationCreatedListener(async (id) => { order.push(`listener:${id}`); throw new Error("plug-in down"); });
      const created = await createOrganization(committingDb(statements, order), { name: "Perso" }, "user-1", "test", false);
      expect(created.kind).toBe("personal");
      // The last transaction is the creation (an earlier one checks the personal space).
      expect(order.slice(-2)).toEqual(["commit", `listener:${created.organizationId}`]);
      expect(order.filter((entry) => entry.startsWith("listener:"))).toHaveLength(1);
      expect(statements.some((statement) => statement.startsWith("insert into organizations"))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("contract: every organization insert of the core is announced", () => {
  const roots = ["modules/identity/src", "apps/api/src"].map((root) => join(import.meta.dir, "../../..", root));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });

  test("a file that inserts into organizations calls announceOrganizationCreated", () => {
    const inserting = roots.flatMap(files).filter((file) => /insert into organizations\b/i.test(readFileSync(file, "utf8")));
    expect(inserting.map((file) => file.replace(/^.*?(modules|apps)\//, "$1/")).sort()).toEqual([
      "modules/identity/src/sql/accounts.ts",
    ]);
    for (const file of inserting) expect(readFileSync(file, "utf8")).toContain("await announceOrganizationCreated(");
    // ...and lets billing attach to it in the same transaction (step 8d).
    for (const file of inserting) expect(readFileSync(file, "utf8")).toContain("await runOrganizationCreating(tx, ");
  });
});
