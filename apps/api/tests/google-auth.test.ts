import { describe, expect, test } from "bun:test";
import type { AuthClaimDto, AuthFailureCode } from "@openedbot/contracts-api";
import type { ApiConfig } from "../src/infrastructure/config";
import { createGoogleAuth } from "@openedbot/identity/application/google-auth";
import type {
  BeginCallbackResult,
  LinkClaimResult,
  LinkOptions,
  NativeClaimResult,
  NativeGoogleCompletion,
  NativeOptions,
  OAuthAttemptStore,
} from "@openedbot/identity/sql/oauth-attempt-store";

type Record = {
  attemptId: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string | null;
  native: NativeOptions | null;
  link?: LinkOptions | null;
  expiresAt: Date;
  status: "pending" | "exchanging" | "done_web" | "done_native" | "done_link" | "failed";
  failure?: AuthFailureCode;
  user?: { email: string; displayName: string | null };
  completion?: NativeGoogleCompletion;
};

/** Store partagé minimal : deux instances GoogleAuth simulent deux processus API. */
class SharedAttemptStore implements OAuthAttemptStore {
  private records = new Map<string, Record>();

  async create(input: Omit<Record, "status">): Promise<void> {
    this.records.set(input.attemptId, { ...input, status: "pending" });
  }

  async beginCallback(state: string): Promise<BeginCallbackResult> {
    const record = [...this.records.values()].find((candidate) => candidate.state === state);
    if (!record || record.status !== "pending" || record.expiresAt.getTime() <= Date.now()) {
      return { ok: false, returnTo: record?.returnTo ?? null };
    }
    record.status = "exchanging";
    return {
      ok: true,
      attempt: {
        attemptId: record.attemptId,
        nonce: record.nonce,
        verifier: record.verifier,
        native: record.native,
        link: record.link ?? null,
        returnTo: record.returnTo,
      },
    };
  }

  async completeWeb(attemptId: string, user: { email: string; displayName: string | null }): Promise<void> {
    const record = this.records.get(attemptId);
    if (record?.status === "exchanging") Object.assign(record, { status: "done_web", user });
  }

  async completeNative(attemptId: string, completion: NativeGoogleCompletion): Promise<void> {
    const record = this.records.get(attemptId);
    if (record?.status === "exchanging") Object.assign(record, { status: "done_native", completion });
  }

  async completeLink(attemptId: string): Promise<void> {
    const record = this.records.get(attemptId);
    if (record?.status === "exchanging") record.status = "done_link";
  }

  async fail(attemptId: string, code: AuthFailureCode): Promise<void> {
    const record = this.records.get(attemptId);
    if (record?.status === "exchanging") Object.assign(record, { status: "failed", failure: code });
  }

  async claimWeb(attemptId: string): Promise<AuthClaimDto> {
    const record = this.records.get(attemptId);
    if (!record) return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
    if (record.status === "pending" || record.status === "exchanging") return { status: "pending" };
    this.records.delete(attemptId);
    if (record.status === "failed") return { status: "failed", code: record.failure! };
    return record.status === "done_web" && record.user
      ? { status: "done", user: record.user }
      : { status: "failed", code: "AUTH_STATE_INVALID" };
  }

  async claimNative(): Promise<NativeClaimResult> {
    return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
  }

  async claimLink(attemptId: string, userId: string): Promise<LinkClaimResult> {
    const record = this.records.get(attemptId);
    if (!record || record.link?.userId !== userId) return { status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" };
    if (record.status === "pending" || record.status === "exchanging") return { status: "pending" };
    this.records.delete(attemptId);
    if (record.status === "failed") return { status: "failed", code: record.failure! };
    return record.status === "done_link" ? { status: "done" } : { status: "failed", code: "AUTH_STATE_INVALID" };
  }
}

const config = {
  publicUrl: "http://localhost:8790",
  webOrigins: ["http://localhost:1420"],
  google: { clientId: "client.test", clientSecret: "secret", allowedEmails: new Set<string>() },
} as unknown as ApiConfig;

describe("Google OAuth durable attempts", () => {
  test("a callback handled by a new API instance still finds the attempt", async () => {
    const store = new SharedAttemptStore();
    const firstProcess = createGoogleAuth(config, store);
    const started = await firstProcess.start("http://localhost:1420/login?redirect=%2F");
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    const restartedProcess = createGoogleAuth(config, store);
    const callback = await restartedProcess.callback(new URLSearchParams({ state, error: "access_denied" }));

    expect(callback).toEqual({
      ok: false,
      attemptId: started.attemptId,
      code: "AUTH_DENIED",
      returnTo: "http://localhost:1420/login?redirect=%2F",
    });
    expect(await restartedProcess.claim(started.attemptId)).toEqual({ status: "failed", code: "AUTH_DENIED" });
    expect(await restartedProcess.claim(started.attemptId)).toEqual({ status: "failed", code: "AUTH_ATTEMPT_UNKNOWN" });
  });

  test("the state is consumed atomically and a replay keeps the safe return URL", async () => {
    const store = new SharedAttemptStore();
    const google = createGoogleAuth(config, store);
    const started = await google.start("http://localhost:1420/login");
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;

    const [first, replay] = await Promise.all([
      google.callback(new URLSearchParams({ state, error: "access_denied" })),
      google.callback(new URLSearchParams({ state, error: "access_denied" })),
    ]);

    expect(first.ok).toBe(false);
    expect(replay.ok).toBe(false);
    if (first.ok || replay.ok) throw new Error("Both callbacks should be rejected after the Google denial.");
    expect([first.code, replay.code].sort()).toEqual(["AUTH_DENIED", "AUTH_STATE_INVALID"]);
    expect(first.returnTo).toBe("http://localhost:1420/login");
    expect(replay.returnTo).toBe("http://localhost:1420/login");
  });

  test("an expired state is rejected but still returns to the trusted application", async () => {
    const store = new SharedAttemptStore();
    await store.create({
      attemptId: "expired-attempt",
      state: "expired-state",
      nonce: "nonce",
      verifier: "verifier",
      returnTo: "http://localhost:1420/login",
      native: null,
      expiresAt: new Date(Date.now() - 1),
    });
    const google = createGoogleAuth(config, store);

    expect(await google.callback(new URLSearchParams({ state: "expired-state", error: "access_denied" }))).toEqual({
      ok: false,
      attemptId: null,
      code: "AUTH_STATE_INVALID",
      returnTo: "http://localhost:1420/login",
    });
  });
});
