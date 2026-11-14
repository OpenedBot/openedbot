#!/usr/bin/env bun
// Offline contract (open-core step 11.5): the core runtime names no payment
// provider. The provider's keys (`manifest.env`), its webhook path
// (`billing.webhookPath`), its signature check and its calls are the plug-in
// billing's (external plug-in); the core only knows the neutral contract
// (`BillingHooks`, `SubscriptionPort`, `PAYMENT_WEBHOOK_UNAVAILABLE`).
//
// Scanned: every TypeScript/JavaScript source of the applications, modules,
// platform, contracts and browser packages, and the core scripts. Not
// scanned, as dated debt (db/ownership.json, `until` 2026-12-31): the
// `subscriptions` and `stripe_events` tables and their migrations (db/), and
// the native clients (Swift: the iOS app and openedbot-notch, in their own
// repositories), which stay out of this step.
// Tests, docs and fixtures may name the provider: they check its absence.
// `ROOT` lets the mutation check point it at another tree.
import { Glob } from "bun";

const ROOT = process.env.PAYMENT_PROVIDER_SCAN_ROOT ?? ".";
const PROVIDER = /stripe/gi;
const PATTERNS = [
  "apps/*/src/**/*.{ts,tsx,js,mjs,css,html,json}",
  "modules/*/src/**/*.{ts,tsx,js,mjs,json}",
  "platform/*/src/**/*.{ts,tsx,js,mjs,json}",
  "contracts/*/src/**/*.{ts,tsx,js,mjs,json}",
  "browser/*/src/**/*.{ts,tsx,js,mjs,css,json}",
  "scripts/**/*.{ts,js,mjs,sh}",
];
const SKIPPED = /(^|\/)(tests?|fixtures|__tests__)\/|\.test\.[a-z]+$/;

const failures: string[] = [];
let scanned = 0;
for (const pattern of PATTERNS) {
  for (const path of new Glob(pattern).scanSync({ cwd: ROOT, dot: false })) {
    if (SKIPPED.test(path) || path.includes("node_modules/")) continue;
    scanned += 1;
    const text = await Bun.file(`${ROOT}/${path}`).text();
    for (const match of text.matchAll(PROVIDER)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${path}:${line}: names the payment provider`);
    }
  }
}

if (scanned === 0) {
  console.error(`payment-provider-contract: nothing scanned under ${ROOT}.`);
  process.exit(2);
}
if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  console.error(`payment-provider-contract: ${failures.length} mention(s) in the core runtime. The provider belongs to the plug-in billing (manifest.env, billing.webhookPath).`);
  process.exit(1);
}
console.log(`payment-provider-contract: ok (${scanned} files)`);
