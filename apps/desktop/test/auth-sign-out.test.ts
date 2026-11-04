import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { NativeTokens } from "../src/main/token-store";

type Request = { url: string; authorization: string | null; body: string | null };
type Route = () => Response | Promise<Response>;

const requests: Request[] = [];
let routes: Record<string, Route> = {};
const logged: string[] = [];

// mock.module is process-wide in Bun: list every export the other desktop
// tests import from electron, or a later file sees a module without them.
mock.module("electron", () => ({
  app: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  nativeTheme: { themeSource: "system" },
  net: {
    fetch: async (input: string, init: { body?: unknown; headers?: Record<string, string> }) => {
      const url = String(input);
      requests.push({ url, authorization: init.headers?.Authorization ?? null, body: init.body === undefined ? null : String(init.body) });
      const route = routes[new URL(url).pathname];
      if (!route) throw new Error(`Unexpected request: ${url}`);
      return route();
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  // Imported by window.ts (window-signin.test.ts).
  BrowserWindow: class {},
  clipboard: {},
  Menu: {},
  screen: {},
}));

const { createAuthService } = await import("../src/main/auth");

const persisted = (expiresInMs = 5 * 60_000): NativeTokens => ({
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  refreshToken: "refresh-token",
  organizationId: "org-1",
});

let stored: NativeTokens | null;
let cleared: number;
let signedOut: string[];
let auth: ReturnType<typeof createAuthService>;
const originalConsoleError = console.error;

function start(initial: NativeTokens): void {
  stored = initial;
  auth = createAuthService({
    config: { apiOrigin: "https://api.example.com", clientId: "desktop-test", consoleUrl: "https://console.example.com", signinTemplate: "console-split" },
    redirectUri: "http://localhost:47813/callback",
    startLoopback: async () => {},
    stopLoopback: () => {},
    events: { onSignedIn: () => {}, onSignedOut: (reason) => signedOut.push(reason), onSigninState: () => {} },
    tokenStore: {
      save: (next) => { stored = next; },
      load: () => stored,
      clear: () => { stored = null; cleared += 1; },
    },
  });
  expect(auth.restore()).toBe(true);
}

beforeEach(() => {
  requests.length = 0;
  logged.length = 0;
  routes = {};
  cleared = 0;
  signedOut = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
});

afterEach(() => {
  auth.dispose();
  console.error = originalConsoleError;
});

test("signOut revokes the session on the API with its access token, then forgets it locally", async () => {
  start(persisted());
  routes["/api/auth/logout"] = () => new Response(null, { status: 204 });
  expect(await auth.signOut()).toEqual({ revocationFailed: false });
  expect(requests).toEqual([{ url: "https://api.example.com/api/auth/logout", authorization: "Bearer access-token", body: null }]);
  expect(auth.isSignedIn()).toBe(false);
  expect(stored).toBeNull();
  expect(signedOut).toEqual(["signed-out"]);
});

test("signOut: a 401 means the session is already revoked (the console did it first)", async () => {
  start(persisted());
  routes["/api/auth/logout"] = () => Response.json({ error: { code: "AUTH_REQUIRED" } }, { status: 401 });
  expect(await auth.signOut()).toEqual({ revocationFailed: false });
  expect(stored).toBeNull();
});

test("signOut: a network failure still clears locally, and is reported and logged", async () => {
  start(persisted());
  routes["/api/auth/logout"] = () => {
    throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
  };
  expect(await auth.signOut()).toEqual({ revocationFailed: true });
  expect(auth.isSignedIn()).toBe(false);
  expect(stored).toBeNull();
  expect(signedOut).toEqual(["signed-out"]);
  expect(logged.join("\n")).toContain("sign-out could not revoke the server session");
  expect(logged.join("\n")).not.toContain("access-token");
});

test("signOut: a server error is reported, never taken for a revocation", async () => {
  start(persisted());
  routes["/api/auth/logout"] = () => Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 503 });
  expect(await auth.signOut()).toEqual({ revocationFailed: true });
  expect(stored).toBeNull();
});

test("signOut: an expired access token is rotated first, and the rotated session is the one revoked", async () => {
  start(persisted(-1_000));
  routes["/api/auth/native/token"] = () => Response.json({ ...persisted(), accessToken: "rotated-access", refreshToken: "rotated-refresh" });
  routes["/api/auth/logout"] = () => new Response(null, { status: 204 });
  expect(await auth.signOut()).toEqual({ revocationFailed: false });
  const logout = requests.find((request) => request.url.endsWith("/api/auth/logout"));
  expect(logout?.authorization).toBe("Bearer rotated-access");
  expect(stored).toBeNull();
});

test("signOut waits for a rotation in flight instead of revoking the session it replaces", async () => {
  start(persisted());
  let answer: (response: Response) => void = () => {};
  routes["/api/auth/native/token"] = () => new Promise<Response>((resolve) => { answer = resolve; });
  routes["/api/auth/logout"] = () => new Response(null, { status: 204 });
  const rotation = auth.refresh();
  const ending = auth.signOut();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requests.some((request) => request.url.endsWith("/api/auth/logout"))).toBe(false);
  answer(Response.json({ ...persisted(), accessToken: "rotated-access", refreshToken: "rotated-refresh" }));
  await rotation;
  expect(await ending).toEqual({ revocationFailed: false });
  expect(requests.find((request) => request.url.endsWith("/api/auth/logout"))?.authorization).toBe("Bearer rotated-access");
  expect(stored).toBeNull();
});
