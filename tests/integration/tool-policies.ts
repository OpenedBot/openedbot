/**
 * PERM2-5 (DEV-OHB-255) against a disposable PostgreSQL database: the
 * per-tool policies of 0141. The API writes its own tenant only, through the
 * real use case; every effective write raises the bot's revision and an
 * unchanged one does not; the constraints refuse a key outside the plugin
 * grammar, an unknown value and an agency actor without its mandate; the
 * worker reads one organization at a time under the tenant setting it sets
 * and restores, never without it, and writes nothing; the real gate
 * resolution denies a blocked tool, even in `bypass`.
 */
import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { setBotToolPolicies, readBotToolPoliciesView } from "../../modules/roster/src/application/tool-policies";
import { readBlockedTools, readToolPolicyTx } from "../../modules/roster/src/sql/tool-policies";
import { resolveGateTx } from "../../modules/execution/src/application/runner/permission-gate";
import type { GateIdentity } from "../../modules/execution/src/domain/gate-identity";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92550000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1);
const ORG_B = id(2);
const AGENCY = id(3);
const USER = id(4);
const BOT_A = id(11);
const BOT_B = id(12);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx as unknown as SQL);
  }) as Promise<T>;
}

async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try { await run(); return false; } catch { return true; }
}

const WRITE: GateIdentity = {
  hermesRequestId: "req-1",
  gateKind: "plugin_tool",
  toolKey: "write_file",
  gateArgs: { tool: "write_file", deletes: "no", opaque: false, digest: "a".repeat(64), args: { path: "notes.md", size: 4 } },
  descriptorVersion: 1,
};

await withDisposablePostgres("ohb255_tool_policies", async ({ owner, connect }) => {
  const api = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  await owner`insert into users (id, email) values (${USER}, 'camille.lefevre@example.com')`;
  for (const [org, slug] of [[ORG_A, "acme"], [ORG_B, "acme-other"], [AGENCY, "acme-agency"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', 'v2')`;
  }
  for (const [org, bot, section] of [[ORG_A, BOT_A, id(21)], [ORG_B, BOT_B, id(22)]] as const) {
    await owner`insert into sections (id, organization_id, name, position) values (${section}, ${org}, 'Bots', 0)`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, 'Scout', 'scout', 0, 'bypass')`;
  }
  const revision = async (bot: string) => Number((await owner<Array<{ r: string }>>`select permission_revision as r from bots where id = ${bot}`)[0]!.r);
  const deps = { readRuntime: async () => null, clientFactory: () => { throw new Error("no host in this proof"); } };
  const member = { userId: USER, kind: "member" as const, agencyOrganizationId: null };

  // 1. The API writes through the real use case; each effective write raises the revision.
  const start = await revision(BOT_A);
  const view = await setBotToolPolicies(api as unknown as Db, deps as never, {
    organizationId: ORG_A, botId: BOT_A, actor: member,
    entries: [{ toolKey: "write_file", policy: "block" }, { toolKey: "mcp:files:delete", policy: "ask" }],
  });
  assert(view.policies.length === 2 && view.enforced && view.hostBlocked === "none", `unexpected view: ${JSON.stringify(view)}`);
  assert(await revision(BOT_A) === start + 2, "two writes did not raise the revision twice");
  await setBotToolPolicies(api as unknown as Db, deps as never, { organizationId: ORG_A, botId: BOT_A, actor: member, entries: [{ toolKey: "write_file", policy: "block" }] });
  assert(await revision(BOT_A) === start + 2, "an unchanged value raised the revision");
  await setBotToolPolicies(api as unknown as Db, deps as never, { organizationId: ORG_A, botId: BOT_A, actor: member, entries: [{ toolKey: "mcp:files:delete", policy: "inherit" }] });
  assert(await revision(BOT_A) === start + 3, "returning a tool to the mode did not raise the revision");
  assert(await revision(BOT_B) === 0, "another bot's revision moved");

  // 2. Tenant isolation on the API side.
  assert((await readBotToolPoliciesView(api as unknown as Db, ORG_A, BOT_A, true)).policies.length === 1, "the API cannot read its own policies");
  assert((await asTenant(api, ORG_B, (tx) => tx`select 1 from bot_permission_tool_policies`)).length === 0, "the API read another tenant's policies");
  assert(await refused(() => asTenant(api, ORG_B, (tx) => tx`
    insert into bot_permission_tool_policies (organization_id, bot_id, tool_key, policy, updated_by_kind)
    values (${ORG_A}, ${BOT_A}, 'patch', 'block', 'member')`)), "the API wrote into another tenant");
  assert(await refused(() => setBotToolPolicies(api as unknown as Db, deps as never, {
    organizationId: ORG_B, botId: BOT_A, actor: member, entries: [{ toolKey: "patch", policy: "block" }],
  })), "a write named a bot of another tenant");

  // 3. Constraints.
  for (const [key, policy, kind, agency] of [
    ["rm -rf", "block", "member", null], ["patch", "never", "member", null], ["patch", "block", "agency", null], ["patch", "block", "member", AGENCY],
  ] as const) {
    assert(await refused(() => owner`
      insert into bot_permission_tool_policies (organization_id, bot_id, tool_key, policy, updated_by_kind, updated_by_agency_organization_id)
      values (${ORG_A}, ${BOT_A}, ${key}, ${policy}, ${kind}, ${agency})`), `the constraint let through ${key}/${policy}/${kind}`);
  }
  await setBotToolPolicies(api as unknown as Db, deps as never, {
    organizationId: ORG_A, botId: BOT_A, actor: { userId: USER, kind: "agency", agencyOrganizationId: AGENCY }, entries: [{ toolKey: "patch", policy: "always" }],
  });
  const actor = (await owner<Array<{ kind: string; agency: string | null }>>`
    select updated_by_kind as kind, updated_by_agency_organization_id as agency from bot_permission_tool_policies where tool_key = 'patch'`)[0];
  assert(actor?.kind === "agency" && actor.agency === AGENCY, `the agency actor was not kept: ${JSON.stringify(actor)}`);

  // 4. The worker: one organization at a time, under the setting it restores; no write.
  assert((await worker`select 1 from bot_permission_tool_policies`).length === 0, "the worker read policies without a tenant");
  const restored = await worker.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG_B}, true)`;
    const policy = await readToolPolicyTx(tx as unknown as SQL, ORG_A, BOT_A, "write_file");
    const after = (await tx<Array<{ value: string }>>`select current_setting('app.organization_id', true) as value`)[0]!.value;
    return { policy, after };
  });
  assert(restored.policy === "block" && restored.after === ORG_B, `the worker read or restore failed: ${JSON.stringify(restored)}`);
  const blocked = await readBlockedTools(worker, ORG_A, BOT_A);
  assert(blocked.length === 1 && blocked[0] === "write_file", `unexpected blocked list: ${JSON.stringify(blocked)}`);
  assert((await readBlockedTools(worker, ORG_B, BOT_A)).length === 0, "an explicit filter on another organization read the bot's keys");
  assert(await refused(() => asTenant(worker, ORG_A, (tx) => tx`delete from bot_permission_tool_policies where organization_id = ${ORG_A}`)),
    "the worker could delete a policy");

  // 5. The real gate resolution denies a blocked tool, even in bypass; another bot is untouched.
  const blockedGate = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, { organizationId: ORG_A, botId: BOT_A, neverWait: false }, WRITE, ["once", "deny"]));
  assert(blockedGate.pipeline === "v2" && blockedGate.choice === "deny" && blockedGate.decision.reason === "tool_blocked",
    `a blocked tool was not denied: ${JSON.stringify(blockedGate)}`);
  const otherGate = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, { organizationId: ORG_B, botId: BOT_B, neverWait: false }, WRITE, ["once", "deny"]));
  assert(otherGate.pipeline === "v2" && otherGate.choice === "once", `another bot was affected: ${JSON.stringify(otherGate)}`);

  // 6. Deleting the bot takes its policies.
  await owner`delete from bots where id = ${BOT_A}`;
  assert((await owner`select 1 from bot_permission_tool_policies where bot_id = ${BOT_A}`).length === 0, "a deleted bot kept its policies");

  console.log("PERM2-5 PostgreSQL proof passed: tool policies, revision, tenant isolation, worker read, gate denial.");
});
