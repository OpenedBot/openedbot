import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { withEffectivePermissions } from "../src/application/bot-effective-permission";

const ORG = "7d000000-0000-4000-8000-000000000001";
const EXPIRES = new Date("2026-11-02T04:00:00.000Z");

type State = {
  pipeline: string;
  policy?: { maxMode: string | null; enforceReview: boolean };
  proven?: boolean;
  leases?: Array<{ id: string; scope: "bot" | "runtime"; botId: string | null }>;
};

function fakeDb(state: State): SQL {
  const tx = ((strings: TemplateStringsArray) => {
    const sql = strings.join("?").replace(/\s+/g, " ");
    if (sql.includes("set_config")) return Promise.resolve([{}]);
    if (sql.includes("from permission_yolo_leases")) return Promise.resolve((state.leases ?? []).map((lease) => ({ ...lease, expiresAt: EXPIRES })));
    if (sql.includes("from organization_permission_policies")) {
      return Promise.resolve(state.policy ? [{ ...state.policy, rulesMode: "adds", commandBlocklist: [], version: 1, updatedAt: null }] : []);
    }
    if (sql.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: state.proven === true }]);
    if (sql.includes("from organizations")) return Promise.resolve([{ pipeline: state.pipeline }]);
    throw new Error(`unexpected query: ${sql}`);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

const bots = [
  { id: "bot-a", permissionMode: "bypass" as const },
  { id: "bot-b", permissionMode: "auto" as const },
  { id: "bot-c", permissionMode: "plan" as const },
];

describe("withEffectivePermissions", () => {
  test("names the rule that lowered each bot, never silently", async () => {
    const out = await withEffectivePermissions(fakeDb({ pipeline: "v2", policy: { maxMode: "auto", enforceReview: false } }), ORG, bots);
    expect(out.map((bot) => bot.effectivePermission)).toEqual([
      { mode: "manual", reason: "review_unproven", yolo: null },
      { mode: "manual", reason: "review_unproven", yolo: null },
      { mode: "plan", reason: null, yolo: null },
    ]);
    const proven = await withEffectivePermissions(fakeDb({ pipeline: "v2", policy: { maxMode: "auto", enforceReview: false }, proven: true }), ORG, bots);
    expect(proven[0]!.effectivePermission).toEqual({ mode: "auto", reason: "ceiling", yolo: null });
  });

  test("a bot lease wins over the runtime one; plan and a blocking policy show none", async () => {
    const leases = [{ id: "lease-runtime", scope: "runtime" as const, botId: null }, { id: "lease-bot", scope: "bot" as const, botId: "bot-b" }];
    const out = await withEffectivePermissions(fakeDb({ pipeline: "v2", proven: true, leases }), ORG, bots);
    expect(out.map((bot) => bot.effectivePermission.yolo)).toEqual([
      { leaseId: "lease-runtime", scope: "runtime", expiresAt: EXPIRES.toISOString() },
      { leaseId: "lease-bot", scope: "bot", expiresAt: EXPIRES.toISOString() },
      null,
    ]);
    const blocked = await withEffectivePermissions(fakeDb({ pipeline: "v2", proven: true, leases, policy: { maxMode: null, enforceReview: true } }), ORG, bots);
    expect(blocked.map((bot) => bot.effectivePermission.yolo)).toEqual([null, null, null]);
    expect(blocked[0]!.effectivePermission).toMatchObject({ mode: "auto", reason: "enforce_review" });
  });

  test("a legacy organization keeps the stored mode", async () => {
    const out = await withEffectivePermissions(fakeDb({ pipeline: "legacy" }), ORG, bots);
    expect(out[0]!.effectivePermission).toEqual({ mode: "bypass", reason: null, yolo: null });
  });
});
