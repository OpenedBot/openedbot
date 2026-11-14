import { afterEach, expect, test } from "bun:test";
import type { OpenedbotNativeBridge } from "../../../src/lib/platform/native-bridge";
import { isClientUpdateRequired, resetClientUpdateRequired } from "../../../src/lib/platform/client-update";
import { subscribeToOrganizationEvents } from "../../../src/lib/stream/use-thread-stream";
import { asDesktopBuild } from "../../support/desktop-build";

// These tests drive the desktop app's bridge, which only the desktop build reads.
asDesktopBuild();

const realFetch = globalThis.fetch;
const bridge: OpenedbotNativeBridge = {
  readAccessToken: async () => "token",
  refresh: async () => "token",
  openExternal: async () => undefined,
  signOut: async () => undefined,
  shell: { platform: "windows", version: "1.0.0" },
};

afterEach(() => {
  globalThis.fetch = realFetch;
  delete window.__OPENEDBOT_NATIVE__;
  window.localStorage.removeItem("openedbot:cloud-session");
  resetClientUpdateRequired();
});

test("un 426 sur le flux de l'organisation l'arrête au lieu de le relancer en boucle", async () => {
  window.__OPENEDBOT_NATIVE__ = bridge;
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "native", userId: "u-1" }));
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    // A real request yields: without that, a retry loop would
    // never let the test timer through, which would stay stuck
    // instead of failing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return new Response(JSON.stringify({ error: { code: "CLIENT_UPDATE_REQUIRED", message: "old", details: { minVersion: "2.0.0", version: "1.0.0" } } }), { status: 426 });
  }) as typeof fetch;
  const unsubscribe = subscribeToOrganizationEvents(() => undefined, () => undefined, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.credentials).toBe("omit");
  expect(new Headers(calls[0]!.headers).get("X-OpenedBot-Client")).toBe("desktop/1.0.0");
  expect(isClientUpdateRequired()).toBe(true);
  // A new screen that subscribes does not reopen a stream doomed to refusal.
  const second = subscribeToOrganizationEvents(() => undefined, () => undefined, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls).toHaveLength(1);
  second();
  unsubscribe();
});
