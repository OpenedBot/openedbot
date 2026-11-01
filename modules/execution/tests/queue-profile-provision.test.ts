import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { claimRun } from "../src/application/queue";

test("claimRun excludes runs while their bot profile provision is unfinished", async () => {
  const statements: string[] = [];
  const db = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([]);
  }) as unknown as SQL;
  (db as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(db);
  await claimRun(db, { workerId: "worker-1", billingEnforced: false, leaseSeconds: 30 } as never);
  const claim = statements.find((sql) => sql.includes("with candidate_run")) ?? "";
  expect(claim).toContain("from bot_profile_provisions pp");
  expect(claim).toContain("pp.status <> 'succeeded'");
});

test("claimRun lets a bot greeting start while its profile is still provisioning (DEV-OHB-244)", async () => {
  const statements: string[] = [];
  const db = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([]);
  }) as unknown as SQL;
  (db as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(db);
  await claimRun(db, { workerId: "worker-1", billingEnforced: false, leaseSeconds: 30 } as never);
  const claim = statements.find((sql) => sql.includes("with candidate_run")) ?? "";
  expect(claim).toContain("and not (r.origin is not distinct from 'bot_greeting' and pp.status in ('queued', 'running'))");
});
