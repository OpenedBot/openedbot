import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Step 11.5: the scan `tests/scripts/payment-provider-contract.ts` (run by
// `make deps-check`) must see a provider mention in every part of the core
// runtime, whatever its case, and leave tests, fixtures and the dated DB
// debt alone.
const SCRIPT = join(import.meta.dir, "../../../tests/scripts/payment-provider-contract.ts");

function scan(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "openedbot-provider-scan-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const run = Bun.spawnSync(["bun", SCRIPT], { env: { ...process.env, PAYMENT_PROVIDER_SCAN_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SEEDED = {
  "apps/api/src/index.ts": "// Stripe\n",
  "apps/console/src/screen.tsx": "export const x = 'STRIPE';\n",
  "modules/support/src/a.ts": "// stripe\n",
  "platform/config/src/env-schema.ts": "export const k = \"STRIPE_SECRET_KEY\";\n",
  "contracts/api/src/api.ts": "/** clés Stripe */\n",
  "browser/face/src/a.ts": "// sTrIpE\n",
  "scripts/deploy.sh": "echo STRIPE_PRICE_ID\n",
};

describe("payment-provider-contract scan (step 11.5)", () => {
  test("flags a mention in every scanned part, whatever its case", () => {
    const { code, out } = scan(SEEDED);
    expect(code).toBe(1);
    for (const path of Object.keys(SEEDED)) expect([path, out.includes(`${path}:1: names the payment provider`)]).toEqual([path, true]);
    expect(out).toContain(`${Object.keys(SEEDED).length} mention(s)`);
  });

  test("leaves tests, fixtures, migrations and native clients alone", () => {
    const { code, out } = scan({
      "apps/api/src/clean.ts": "export const ok = 1;\n",
      "apps/api/tests/a.test.ts": "// stripe\n",
      "apps/api/src/tests/helper.ts": "// stripe\n",
      "platform/plugins/src/fixtures/a.ts": "// stripe\n",
      "apps/api/src/a.test.ts": "// stripe\n",
      "db/migrations/0002_billing.sql": "create table stripe_events ();\n",
      "native/notch/SettingsView.swift": "// stripe\n",
    });
    expect([code, out.trim()]).toEqual([0, "payment-provider-contract: ok (1 files)"]);
  });

  test("an empty tree is an error, not a pass", () => {
    expect(scan({ "README.md": "x\n" }).code).toBe(2);
  });
});
