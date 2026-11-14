#!/usr/bin/env bun
// Offline contract (open-core step 8b): nothing in the permission pipeline
// reads the permission tables around the `PermissionRuleSource` port.
//
// dependency-cruiser (`porte-permissions-par-le-port`) sees the imports of the
// roster and runtime SQL helpers; it cannot see a query written inline. This
// scan does: in the execution module and the worker, the rule tables, the
// grants, the tool policies, the organization policy, the runtime terminal
// switch and the workflows' "Never wait" are read by the core source
// (`core-permission-rules.ts`) only. `routines.ts` reads a routine's
// "Never wait" to copy it into the workflow it fires (0144), and the creation
// primitive `sql/run-writes.ts` writes that snapshot (S2b);
// `routine-tool-state.ts` reads it to describe a `routine_manage` gate.
import { Glob } from "bun";

const ROOTS = ["modules/execution/src", "apps/worker/src"];
const ALLOWED: Record<string, readonly string[]> = {
  "modules/execution/src/application/runner/core-permission-rules.ts": ["table", "never_wait"],
  "modules/execution/src/application/routines.ts": ["never_wait"],
  "modules/execution/src/sql/run-writes.ts": ["never_wait"],
  // A routine's "Never wait", read to SAY it in a `routine_manage` approval's
  // description (`readRoutineGateTargets`): display only, no decision reads it.
  "modules/execution/src/application/routine-tool-state.ts": ["never_wait"],
};
const TABLE = /\b(?:from|join)\s+(bot_permission_rules|organization_permission_policies|bot_permission_grants|bot_permission_tool_policies|runtime_permission_settings)\b/g;
// A column, not the reason code `"never_wait"` the traces carry, nor a
// column named in backquotes in a comment.
const NEVER_WAIT = /(?<!["'`])\bnever_wait\b(?!["'`])/g;

const failures: string[] = [];
for (const root of ROOTS) {
  for (const file of new Glob("**/*.{ts,tsx}").scanSync(root)) {
    const path = `${root}/${file}`;
    const allowed = ALLOWED[path] ?? [];
    const text = await Bun.file(path).text();
    if (!allowed.includes("table")) {
      for (const match of text.matchAll(TABLE)) failures.push(`${path}: reads ${match[1]} around the PermissionRuleSource port`);
    }
    if (!allowed.includes("never_wait") && NEVER_WAIT.test(text)) failures.push(`${path}: reads never_wait around the PermissionRuleSource port`);
    NEVER_WAIT.lastIndex = 0;
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`permission-port-contract: ${failures.length} read(s) around the port. Read through permissionRuleSourceFor() (core-permission-rules.ts for the core).`);
  process.exit(1);
}
console.log("permission-port-contract: ok");
