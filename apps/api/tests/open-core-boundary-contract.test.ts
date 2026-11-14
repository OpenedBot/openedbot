import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Open-core boundary: the scan `tests/scripts/open-core-boundary-contract.ts`
// (run by `make deps-check`) must flag every paid seam that comes back into
// the core sources, keep its small allow-list, and leave tests and
// migrations alone. It also passes on this very tree.
const SCRIPT = join(import.meta.dir, "../../../tests/scripts/open-core-boundary-contract.ts");
const REPO = join(import.meta.dir, "../../..");

/** `untracked` files are written but never `git add`ed (build output). */
function scan(files: Record<string, string> | null, untracked: Record<string, string> = {}) {
  const root = files ? mkdtempSync(join(tmpdir(), "openedbot-boundary-scan-")) : REPO;
  try {
    for (const [path, text] of Object.entries(files ?? {})) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    if (files) {
      const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      git("init", "-q");
      git("add", "-A");
      for (const [path, text] of Object.entries(untracked)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
    }
    const run = Bun.spawnSync(["bun", SCRIPT], { env: { ...process.env, OPEN_CORE_SCAN_ROOT: root }, stdout: "pipe", stderr: "pipe", cwd: REPO });
    return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}` };
  } finally {
    if (files) rmSync(root, { recursive: true, force: true });
  }
}

describe("open-core-boundary-contract scan", () => {
  test("the core tree passes", () => {
    const { code, out } = scan(null);
    expect([code, out.trim()]).toEqual([0, expect.stringMatching(/^open-core-boundary-contract: ok \(\d+ files\)$/)]);
  });

  test("flags an audit S3 client, AUDIT_WORM_* names, SAML/SCIM, staff and plug-in entitlement gates", () => {
    const seeded = {
      "modules/runtime-link/src/application/audit-archive.ts": "const c = new Bun.S3Client({});\n",
      "apps/api/src/worm.ts": "const s = new S3Client({}); // audit anchors\n",
      "platform/config/src/env.ts": "export const k = \"AUDIT_WORM_BUCKET\";\n",
      "apps/api/src/sso.ts": "// SAML login\nexport const scim = 1;\n",
      "contracts/api/src/staff.ts": "export type StaffUserDto = {};\n",
      "apps/console/src/menu.tsx": "const impersonating = true;\n",
      "browser/face/src/a.ts": "// back office staff\n",
      "apps/worker/src/gate.ts": "await entitlements.has(\"permissions.v2\", scope);\n",
      "apps/api/src/gate.ts": "await entitlements.has(entitlement);\n",
    };
    const { code, out } = scan(seeded);
    expect(code).toBe(1);
    expect(out).toContain("modules/runtime-link/src/application/audit-archive.ts:1: an S3/R2 client next to the audit");
    expect(out).toContain("apps/api/src/worm.ts:1: an S3/R2 client next to the audit");
    expect(out).toContain("platform/config/src/env.ts:1: names AUDIT_WORM_BUCKET");
    expect(out).toContain("apps/api/src/sso.ts:1: names SAML");
    expect(out).toContain("apps/api/src/sso.ts:2: names scim");
    expect(out).toContain("contracts/api/src/staff.ts:1: names \"Staff\"");
    expect(out).toContain("apps/console/src/menu.tsx:1: names \"impersonat\"");
    expect(out).toContain("browser/face/src/a.ts:1: names \"staff\"");
    expect(out).toContain("apps/worker/src/gate.ts:1: entitlements.has(\"permissions.v2\")");
    // The generic mount gate is allowed in apps/api/src/index.ts only.
    expect(out).toContain("apps/api/src/gate.ts:1: entitlements.has(entitlement)");
  });

  test("keeps the allow-list: column, API field, error code, team format, the core gates", () => {
    const { code, out } = scan({
      "modules/identity/src/sql/sessions.ts": "select s.impersonated_by_staff_user_id as \"assistedBy\" from sessions s\n",
      "contracts/api/src/identity/auth.ts": "export type Me = { impersonation?: { readOnly: true } | null };\n",
      "apps/api/src/routes/identity/auth.ts": "throw new HttpError(403, \"IMPERSONATION_READ_ONLY\", \"x\");\n",
      "modules/portability/src/domain/team-markdown.ts": "const chiefOfStaff = 'Chief of Staff'; // chief-of-staff\n",
      "apps/api/src/application/dev-reset.ts": "export const kept = [\"staff_users\", \"staff_sessions\"];\n",
      "modules/identity/src/sql/product-features.ts": "return value === \"off\" ? value : \"assisted\"; // stored `staff`\n",
      "apps/api/src/index.ts": "await entitlements.has(PRO_ENTITLEMENTS.billingEnforced);\nawait entitlements.has(\"core.threads\", scope);\nentitlements.has(entitlement, caller);\nentitlements.has(PRO_ENTITLEMENTS.auditAnchor, { organizationId });\n",
      "apps/api/src/infrastructure/blob-store.ts": "const files = new Bun.S3Client({}); // attachments\n",
    });
    expect([code, out.trim()]).toEqual([0, "open-core-boundary-contract: ok (8 files)"]);
  });

  test("scans tracked files only: an untracked build file is ignored", () => {
    const { code, out } = scan(
      { "apps/api/src/clean.ts": "export const ok = 1;\n" },
      { "apps/desktop-tauri/console-dist/assets/index.js": "var a=\"impersonat\";\n" },
    );
    expect([code, out.trim()]).toEqual([0, "open-core-boundary-contract: ok (1 files)"]);
  });

  test("a file-scoped allowance does not leak to another file", () => {
    const { code, out } = scan({ "apps/api/src/other.ts": "export const kept = [\"staff_users\"];\n" });
    expect(code).toBe(1);
    expect(out).toContain("apps/api/src/other.ts:1: names \"staff\"");
  });

  test("leaves tests, fixtures and migrations alone; an empty tree is an error", () => {
    const { code, out } = scan({
      "apps/api/src/clean.ts": "export const ok = 1;\n",
      "apps/api/tests/a.test.ts": "// staff SAML AUDIT_WORM_MODE\n",
      "platform/plugins/src/fixtures/a.ts": "// staff\n",
      "apps/api/src/a.test.ts": "// impersonating\n",
      "db/migrations/0029_staff_impersonation.sql": "alter table sessions add column impersonated_by_staff_user_id uuid;\n",
    });
    expect([code, out.trim()]).toEqual([0, "open-core-boundary-contract: ok (1 files)"]);
    expect(scan({ "README.md": "x\n" }).code).toBe(2);
  });
});
