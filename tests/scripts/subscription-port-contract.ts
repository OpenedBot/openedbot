#!/usr/bin/env bun
// Offline contract (open-core steps 8c, 11.4): nothing in the core reads or
// writes `subscriptions` itself; the core goes through `SubscriptionPort`
// (`platform/db/src/subscription-port.ts`), which the plug-in billing
// implements (external plug-in, since step 11.4 with all its SQL).
//
// The billing SQL helpers left the core with `modules/billing` (step 11.4),
// so no import can reach them any more; what remains possible is a query
// written inline. This scan sees it: in every
// application, module and platform package, no file names the table in a
// statement: the table and its migrations stay in the core as dated debt
// (db/ownership.json), its SQL does not.
// `ROOT` lets the mutation check point it at another tree.
import { Glob } from "bun";

const ROOT = process.env.SUBSCRIPTION_PORT_SCAN_ROOT ?? ".";
const ALLOWED = new Set<string>();
// `\b` keeps `push_subscriptions` out (`_` is a word character).
const STATEMENT = /\b(?:from|join|into|update|table)\s+subscriptions\b/gi;

const failures: string[] = [];
for (const pattern of ["apps/*/src/**/*.{ts,tsx}", "modules/*/src/**/*.{ts,tsx}", "platform/*/src/**/*.{ts,tsx}"]) {
  for (const path of new Glob(pattern).scanSync(ROOT)) {
    if (ALLOWED.has(path)) continue;
    const text = await Bun.file(`${ROOT}/${path}`).text();
    for (const match of text.matchAll(STATEMENT)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${path}:${line}: "${match[0]}" around the SubscriptionPort`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  console.error(`subscription-port-contract: ${failures.length} access(es) around the port. Read through subscriptionPort() (@openedbot/platform-db/subscription-port).`);
  process.exit(1);
}
console.log("subscription-port-contract: ok");
