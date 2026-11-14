import { expect, test } from "bun:test";
import { forceOnlyOwnedGroupRefusal, type CleanupGroup } from "./cleanup-groups";
const refusal = (status = 409, body: unknown = { error: { code: "BOT_IN_GROUP" } }) => Response.json(body, { status });
const owned = (): CleanupGroup[] => [{ id: "group", organizationId: "org", members: [
  { botId: "a", organizationId: "org" }, { botId: "b", organizationId: "org" },
] }];
function fixture(groups = owned()) {
  const calls: string[] = [];
  return { groups, calls, async run(response = refusal(), load = async () => { calls.push("read"); return groups; }) {
    return forceOnlyOwnedGroupRefusal(response, "a", "org", new Set(["a", "b"]), load,
      async () => { calls.push("settle"); }, async () => { calls.push("force"); return Response.json({ hostCleanup: "queued" }); });
  } };
}

test("exact group refusal permits force only after ownership read, settlement and re-audit", async () => {
  const f = fixture(); expect((await f.run()).ok).toBe(true);
  expect(f.calls).toEqual(["read", "settle", "read", "force"]);
});
for (const [status, body] of [
  [500, { error: { code: "BOT_IN_GROUP" } }], [404, { error: { code: "BOT_IN_GROUP" } }],
  [409, { error: { code: "BOT_BUSY" } }], [409, { error: { code: "OTHER" } }],
  [409, { code: "BOT_IN_GROUP" }], [409, { error: null }], [409, null], [200, {}],
] as const) test(`never forces unrelated response ${status}/${JSON.stringify(body)}`, async () => {
  const f = fixture(), response = refusal(status, body);
  expect(await f.run(response)).toBe(response); expect(f.calls).toEqual([]);
});
test("malformed error body never grants force authority", async () => {
  const f = fixture(), response = new Response("not JSON", { status: 409 });
  expect(await f.run(response)).toBe(response); expect(f.calls).toEqual([]);
});
for (const [label, mutate] of Object.entries<(groups: CleanupGroup[]) => void>({
  foreign: (groups) => { groups[0]!.members.push({ botId: "operator", organizationId: "org" }); },
  null: (groups) => { groups[0]!.members[1]!.botId = null; },
  missing: (groups) => { groups[0]!.members[1]!.organizationId = null; },
  otherTenant: (groups) => { groups[0]!.organizationId = "other"; },
  otherMemberTenant: (groups) => { groups[0]!.members[1]!.organizationId = "other"; },
  noTarget: (groups) => { groups[0]!.members = groups[0]!.members.slice(1); },
  noMembers: (groups) => { groups[0]!.members = []; },
  noGroupId: (groups) => { groups[0]!.id = null; },
  noGroups: (groups) => { groups.length = 0; },
  laterForeignGroup: (groups) => { groups.push({ id: "foreign", organizationId: "org", members: [{ botId: "operator", organizationId: "org" }] }); },
})) test(`force refuses ${label} before settlement or deletion`, async () => {
  const f = fixture(); mutate(f.groups);
  await expect(f.run()).rejects.toThrow("Forced purge refused"); expect(f.calls).toEqual(["read"]);
});
test("membership changed during settlement cannot authorize force", async () => {
  const f = fixture(); let reads = 0;
  await expect(f.run(refusal(), async () => {
    f.calls.push("read"); if (++reads > 1) f.groups[0]!.members.push({ botId: "foreign", organizationId: "org" }); return f.groups;
  })).rejects.toThrow("Forced purge refused");
  expect(f.calls).toEqual(["read", "settle", "read"]);
});

test("settlement failure blocks force and an unsuccessful forced request is never retried", async () => {
  let forceCalls = 0;
  await expect(forceOnlyOwnedGroupRefusal(refusal(), "a", "org", new Set(["a", "b"]), async () => owned(),
    async () => { throw new Error("still active"); }, async () => { forceCalls++; return new Response(null, { status: 500 }); })).rejects.toThrow("still active");
  expect(forceCalls).toBe(0);
  const response = await forceOnlyOwnedGroupRefusal(refusal(), "a", "org", new Set(["a", "b"]), async () => owned(),
    async () => {}, async () => { forceCalls++; return new Response(null, { status: 500 }); });
  expect(response.status).toBe(500); expect(forceCalls).toBe(1);
});
