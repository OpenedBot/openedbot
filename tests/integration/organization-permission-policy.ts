/**
 * PERM2-8 against a disposable PostgreSQL database: the
 * organization permission policy (0142). Only a live owner or admin member
 * writes it, through the definer function and inside its own tenant; a
 * member or the owner of another organization is refused; the API never writes the table directly; every change raises the
 * revision of every bot of the organization and of no other; the ceiling
 * guard refuses raising a bot above it and allows lowering; the blocklist
 * constraint refuses a non-canonical entry; the worker reads the policy.
 */
import type { SQL } from "bun";
import { readOrganizationPermissionPolicy, writeOrganizationPermissionPolicy } from "../../modules/identity/src/sql/permission-policy";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92590000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OTHER = id(2);
const LEGACY = id(3);
const FOREIGN = id(4);
const OWNER = id(11);
const ADMIN = id(12);
const MEMBER = id(13);
const STRANGER = id(14);
const SECTION = id(21);
const OTHER_SECTION = id(22);
const BOT_A = id(31);
const BOT_B = id(32);
const OTHER_BOT = id(33);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx as unknown as SQL);
  }) as Promise<T>;
}

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const details = error as { errno?: unknown; code?: unknown; message?: unknown };
    return String(details.errno ?? details.code ?? details.message);
  }
  throw new Error("the operation was expected to fail");
}

const policy = (overrides: Partial<Parameters<typeof writeOrganizationPermissionPolicy>[1]> = {}) => ({
  organizationId: ORG,
  actorUserId: OWNER,
  maxMode: "auto" as const,
  enforceReview: false,
  rulesMode: "adds" as const,
  commandBlocklist: ["git push --force", "rm -rf"],
  expectedVersion: 0,
  ...overrides,
});

await withDisposablePostgres("openedbot259_org_policy", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const worker = await connect("openedbot_worker");
  for (const [user, email] of [[OWNER, "camille@example.com"], [ADMIN, "admin@example.com"], [MEMBER, "member@example.com"], [STRANGER, "stranger@example.com"]] as const) {
    await owner`insert into users (id, email) values (${user}, ${email})`;
  }
  for (const [org, slug, pipeline] of [[ORG, "acme", "v2"], [OTHER, "acme-other", "v2"], [LEGACY, "acme-legacy", "legacy"], [FOREIGN, "acme-foreign", "v2"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', ${pipeline})`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values
    (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'), (${ORG}, ${MEMBER}, 'member'),
    (${LEGACY}, ${OWNER}, 'owner'), (${FOREIGN}, ${STRANGER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Acme', 0), (${OTHER_SECTION}, ${OTHER}, 'Acme', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode) values
    (${BOT_A}, ${ORG}, ${SECTION}, 'Scout', 'scout', 0, 'bypass'),
    (${BOT_B}, ${ORG}, ${SECTION}, 'Atlas', 'atlas', 1, 'manual'),
    (${OTHER_BOT}, ${OTHER}, ${OTHER_SECTION}, 'Pixel', 'pixel', 0, 'manual')`;
  const revisions = async () => Object.fromEntries((await owner<Array<{ id: string; revision: string | number }>>`
    select id, permission_revision as revision from bots`).map((row) => [row.id, Number(row.revision)]));

  // 1. A member, another organization's owner and a mismatched tenant are refused; nothing is written.
  assert(await refused(() => asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy({ actorUserId: MEMBER })))) === "42501",
    "a member wrote the organization policy");
  assert(await refused(() => asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy({ actorUserId: STRANGER })))) === "42501",
    "another organization's owner wrote this policy");
  assert(await refused(() => asTenant(api, OTHER, (tx) => writeOrganizationPermissionPolicy(tx, policy()))) === "42501",
    "a write crossed tenants");
  assert((await owner`select 1 from organization_permission_policies`).length === 0, "a refused write left a row");

  // 2. The API never writes the table directly.
  await refused(() => asTenant(api, ORG, (tx) => tx`insert into organization_permission_policies (organization_id, max_mode) values (${ORG}, 'bypass')`));
  assert((await owner`select 1 from organization_permission_policies`).length === 0, "the API inserted a policy directly");

  // 3. An owner saves; every bot of the organization moves, no other.
  const before = await revisions();
  const saved = await asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy()));
  assert(saved.status === "saved" && saved.version === 1, `owner save failed: ${JSON.stringify(saved)}`);
  const after = await revisions();
  assert(after[BOT_A] === before[BOT_A]! + 1 && after[BOT_B] === before[BOT_B]! + 1, `the revision did not move: ${JSON.stringify({ before, after })}`);
  assert(after[OTHER_BOT] === before[OTHER_BOT], "another organization's bot moved");

  // 4. A stale version conflicts, an identical save is unchanged and moves nothing, an admin saves.
  assert((await asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy({ actorUserId: ADMIN })))).status === "conflict",
    "a stale version was accepted");
  assert((await asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy({ expectedVersion: 1 })))).status === "unchanged",
    "an identical save was not unchanged");
  assert((await revisions())[BOT_A] === after[BOT_A], "an unchanged save moved the revision");
  const lowered = await asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, policy({ actorUserId: ADMIN, maxMode: "manual", expectedVersion: 1 })));
  assert(lowered.status === "saved" && lowered.version === 2, `admin save failed: ${JSON.stringify(lowered)}`);
  assert((await revisions())[BOT_B] === after[BOT_B]! + 1, "lowering the ceiling did not move the revision");

  // 5. A legacy organization stores nothing it could not enforce.
  const legacy = await asTenant(api, LEGACY, (tx) => writeOrganizationPermissionPolicy(tx, policy({ organizationId: LEGACY })));
  assert(legacy.status === "pipeline_legacy", `a legacy organization stored a policy: ${JSON.stringify(legacy)}`);

  // 6. Reads: the tenant and the worker see it, another tenant does not.
  const read = await asTenant(api, ORG, (tx) => readOrganizationPermissionPolicy(tx, ORG));
  assert(read?.maxMode === "manual" && read.commandBlocklist.join("|") === "git push --force|rm -rf" && read.version === 2,
    `unexpected tenant read: ${JSON.stringify(read)}`);
  assert((await asTenant(api, OTHER, (tx) => readOrganizationPermissionPolicy(tx, ORG))) === null, "another tenant read the policy");
  assert((await readOrganizationPermissionPolicy(worker, ORG))?.maxMode === "manual", "the worker cannot read the policy");

  // 7. The ceiling guard: a raise is refused, lowering and plan pass, a bot above stays stored.
  assert((await owner<Array<{ mode: string }>>`select permission_mode as mode from bots where id = ${BOT_A}`)[0]?.mode === "bypass",
    "a bot above the ceiling was rewritten");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`update bots set permission_mode = 'auto' where id = ${BOT_B}`)) === "42501",
    "a bot was raised above the ceiling");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
    values (${id(34)}, ${ORG}, ${SECTION}, 'Nova', 'nova', 2, 'bypass')`)) === "42501", "a bot was created above the ceiling");
  await asTenant(api, ORG, (tx) => tx`update bots set permission_mode = 'auto' where id = ${BOT_A}`);
  await asTenant(api, ORG, (tx) => tx`update bots set permission_mode = 'plan' where id = ${BOT_B}`);
  await asTenant(api, ORG, (tx) => tx`update bots set name = 'Scout II' where id = ${BOT_A}`);
  await asTenant(api, OTHER, (tx) => tx`update bots set permission_mode = 'bypass' where id = ${OTHER_BOT}`);

  // 8. The blocklist constraint refuses a non-canonical or oversized list, even to the owner role.
  for (const list of [["rm;ls"], [" rm"], ["rm  -rf"], ["sudo rm"], ["/bin/rm"], ["rm", "rm"], Array.from({ length: 51 }, (_, i) => `t${i}`)]) {
    assert(await refused(() => owner`update organization_permission_policies set command_blocklist = ${`{${list.map((e) => `"${e}"`).join(",")}}`}::text[] where organization_id = ${ORG}`) === "23514",
      `an invalid blocklist was stored: ${JSON.stringify(list)}`);
  }

  console.log("PERM2-8 PostgreSQL proof passed: role and tenant guard, revision bump, ceiling guard, blocklist constraint, reads.");
});
