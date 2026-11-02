import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { YoloLease } from "@openedbot/contracts-api";
import {
  buildYoloSoloLease,
  createYoloLeaseSigner,
  reconcileYoloSoloDefault,
  YOLO_SOLO_RENEW_BEFORE_SECONDS,
  type YoloLeaseDeps,
  type YoloPolicyRead,
} from "../src/application/yolo-leases";
import { validateYoloLeaseShape, verifyYoloLeaseSignature } from "../src/domain/yolo-lease";
import { yoloProtectionHit } from "../src/domain/yolo-hardline";

const ORG = "7d000000-0000-4000-8000-000000000001";
const OWNER = "7d000000-0000-4000-8000-000000000011";
const RUNTIME = "7d000000-0000-4000-8000-000000000021";
const OLD_LEASE = "7d000000-0000-4000-8000-000000000031";
const NOW = 1_800_000_000_000;
// A public TEST seed (0x00..0x1f), the one of the shared lease vector: never a real key.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

type State = {
  members?: Array<{ userId: string; role: string }>;
  consent?: boolean;
  due?: string[];
  grantStatus?: string;
  ended?: { status: string; leaseIds: string[]; runtimeIds: string[] };
};

type Call = { sql: string; parameters: unknown[] };

function fakeDb(state: State, calls: Call[]): SQL {
  const tx = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql, parameters });
    if (sql.includes("set_config")) return Promise.resolve([{}]);
    if (sql.includes("from memberships where")) return Promise.resolve(state.members ?? [{ userId: OWNER, role: "owner" }]);
    if (sql.includes("from memberships m join users")) {
      return Promise.resolve([{ userId: OWNER, email: "owner@example.com", organizationSlug: "atelier", organizationName: "Atelier" }]);
    }
    if (sql.includes("from permission_yolo_consents")) return Promise.resolve(state.consent === false ? [] : [{ userId: OWNER }]);
    if (sql.includes("select r.id from runtimes r")) return Promise.resolve((state.due ?? [RUNTIME]).map((id) => ({ id })));
    if (sql.includes("grant_permission_yolo_solo_lease")) {
      const status = state.grantStatus ?? "granted";
      return Promise.resolve([{ status, superseded: status === "granted" ? [OLD_LEASE] : [] }]);
    }
    if (sql.includes("end_permission_yolo_solo_default")) {
      return Promise.resolve([state.ended ?? { status: "ended", leaseIds: [OLD_LEASE], runtimeIds: [RUNTIME] }]);
    }
    if (sql.includes("insert into email_outbox")) return Promise.resolve(Object.assign([], { count: 1 }));
    throw new Error(`unexpected query: ${sql}`);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

type Pushed = { kind: "lease" | "revoke"; runtimeId: string; frame: Record<string, unknown> };

function setup(state: State, options: { policy?: Awaited<ReturnType<YoloPolicyRead>>; seed?: Uint8Array | null } = {}) {
  const calls: Call[] = [];
  const pushed: Pushed[] = [];
  const deps: YoloLeaseDeps = {
    signer: createYoloLeaseSigner({ seed: options.seed === undefined ? TEST_SEED : options.seed, previousSeeds: [] }),
    publisher: {
      pushLease: async ({ runtimeId, frame }) => { pushed.push({ kind: "lease", runtimeId, frame }); },
      pushRevoke: async ({ runtimeId, frame }) => { pushed.push({ kind: "revoke", runtimeId, frame }); },
    },
    readPolicy: async () => options.policy ?? null,
    now: () => NOW,
    webAppUrl: "https://app.example.test",
  };
  const db = fakeDb(state, calls);
  return { run: () => reconcileYoloSoloDefault(db, deps, ORG), calls, pushed, deps };
}

const called = (calls: Call[], fragment: string) => calls.filter((call) => call.sql.includes(fragment));

describe("buildYoloSoloLease", () => {
  const lease = buildYoloSoloLease({ organizationId: ORG, runtimeId: RUNTIME, ownerUserId: OWNER, commandBlocklist: ["git push --force"], now: NOW / 1000 });

  test("a 24 h runtime lease for the owner, with the organization's deny-list", () => {
    expect(validateYoloLeaseShape(lease)).toEqual({ ok: true });
    expect(lease).toMatchObject({
      v: 1, organizationId: ORG, runtimeId: RUNTIME, scope: "runtime", profile: null, sessionKey: null, grantedBy: OWNER,
      issuedAt: NOW / 1000, notBefore: NOW / 1000, expiresAt: NOW / 1000 + 86_400,
      deny: { commands: ["git push --force"], tools: [], paths: [] },
    });
  });

  test("always protects .ssh, .env (and its variants) and the keychain", () => {
    expect(lease.protect).toEqual(expect.arrayContaining(["ssh", "env", "keychain"]));
    const blocked = (subject: { paths?: string[]; command?: string }) =>
      yoloProtectionHit({ toolKey: "write_file", paths: subject.paths ?? [], command: subject.command ?? null }, lease.protect);
    expect(blocked({ paths: ["/Users/me/.ssh/id_ed25519"] })).toBe("ssh");
    expect(blocked({ paths: ["app/.env"] })).toBe("env");
    expect(blocked({ paths: ["app/.env.local"] })).toBe("env");
    expect(blocked({ command: "cat .env.production" })).toBe("env");
    expect(blocked({ paths: ["/Users/me/Library/Keychains/login.keychain-db"] })).toBe("keychain");
    expect(blocked({ command: "security dump-keychain" })).toBe("keychain");
    expect(blocked({ paths: ["/tmp/build/out.txt"] })).toBeNull();
    expect(blocked({ paths: ["app/.envrc"] })).toBeNull();
  });
});

describe("reconcileYoloSoloDefault", () => {
  test("solo and consented: one signed lease per due runtime, the previous one revoked, pushed after the commit", async () => {
    const target = setup({});
    expect(await target.run()).toEqual({ renewed: 1, ended: false, skipped: [] });
    const grant = called(target.calls, "grant_permission_yolo_solo_lease");
    expect(grant).toHaveLength(1);
    expect(grant[0]!.parameters[1]).toBe(OWNER);
    expect(grant[0]!.parameters[5]).toBe(YOLO_SOLO_RENEW_BEFORE_SECONDS);
    expect(target.pushed.map((entry) => entry.kind)).toEqual(["revoke", "lease"]);
    expect(target.pushed[0]!.frame).toEqual({ t: "yolo.revoke", leaseId: OLD_LEASE, revokedAt: NOW / 1000 });
    const frame = target.pushed[1]!.frame as { lease: YoloLease; keyId: string; signature: string };
    expect(JSON.parse(String(grant[0]!.parameters[4]))).toEqual(frame.lease);
    expect(verifyYoloLeaseSignature(frame.lease, frame.keyId, frame.signature, target.deps.signer.keys)).toEqual({ ok: true });
  });

  test("idempotent: a lease the database says is not due is never pushed", async () => {
    const target = setup({ grantStatus: "not_due" });
    expect(await target.run()).toEqual({ renewed: 0, ended: false, skipped: [] });
    expect(target.pushed).toEqual([]);
    const idle = setup({ due: [] });
    expect(await idle.run()).toEqual({ renewed: 0, ended: false, skipped: [] });
    expect(called(idle.calls, "grant_permission_yolo_solo_lease")).toEqual([]);
  });

  test("without consent (never given, or reset by a kill) nothing is signed", async () => {
    const target = setup({ consent: false });
    expect(await target.run()).toEqual({ renewed: 0, ended: false, skipped: [] });
    expect(called(target.calls, "grant_permission_yolo_solo_lease")).toEqual([]);
    expect(called(target.calls, "end_permission_yolo_solo_default")).toEqual([]);
    expect(target.pushed).toEqual([]);
    // A kill between the read and the grant: the database answers consent_off, named, nothing pushed.
    const raced = setup({ grantStatus: "consent_off" });
    expect(await raced.run()).toEqual({ renewed: 0, ended: false, skipped: [{ runtimeId: RUNTIME, status: "consent_off" }] });
    expect(raced.pushed).toEqual([]);
  });

  test("a second member ends the solo default: superseded by the system, the host told, the owner e-mailed", async () => {
    const target = setup({ members: [{ userId: OWNER, role: "owner" }, { userId: "7d000000-0000-4000-8000-000000000012", role: "member" }] });
    expect(await target.run()).toEqual({ renewed: 0, ended: true, skipped: [] });
    expect(called(target.calls, "end_permission_yolo_solo_default")[0]!.parameters).toEqual([ORG, null]);
    expect(called(target.calls, "grant_permission_yolo_solo_lease")).toEqual([]);
    expect(target.pushed).toEqual([{ kind: "revoke", runtimeId: RUNTIME, frame: { t: "yolo.revoke", leaseId: OLD_LEASE, revokedAt: NOW / 1000 } }]);
    const email = called(target.calls, "insert into email_outbox");
    expect(email).toHaveLength(1);
    expect(email[0]!.parameters.slice(1, 5)).toEqual(["yolo_solo_default_ended", `yolo_solo_default_ended:${ORG}:${OWNER}:${NOW / 1000}`, "owner@example.com", "fr"]);
    // Already ended: no second e-mail.
    const replay = setup({ members: [{ userId: OWNER, role: "admin" }], ended: { status: "unchanged", leaseIds: [], runtimeIds: [] } });
    expect((await replay.run()).ended).toBe(false);
    expect(called(replay.calls, "insert into email_outbox")).toEqual([]);
  });

  test("a policy that forbids YOLO or a missing signing key is named, never a silent lease", async () => {
    const ceiling = setup({}, { policy: { maxMode: "auto", enforceReview: false, commandBlocklist: [] } });
    expect(await ceiling.run()).toEqual({ renewed: 0, ended: false, skipped: [{ runtimeId: null, status: "blocked_ceiling" }] });
    const review = setup({}, { policy: { maxMode: null, enforceReview: true, commandBlocklist: [] } });
    expect((await review.run()).skipped).toEqual([{ runtimeId: null, status: "blocked_enforce_review" }]);
    const unsigned = setup({}, { seed: null });
    expect((await unsigned.run()).skipped).toEqual([{ runtimeId: null, status: "signing_unavailable" }]);
    for (const target of [ceiling, review, unsigned]) {
      expect(called(target.calls, "grant_permission_yolo_solo_lease")).toEqual([]);
      expect(target.pushed).toEqual([]);
    }
  });
});
