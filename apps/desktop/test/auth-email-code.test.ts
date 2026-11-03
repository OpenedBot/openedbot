import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SigninState } from "../src/shared/bridge";

type Request = { url: string; body: Record<string, unknown> };
type Route = (body: Record<string, unknown>) => Response | Promise<Response>;

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
    fetch: async (input: string, init: { body?: unknown; signal?: AbortSignal }) => {
      const url = String(input);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ url, body });
      const route = routes[new URL(url).pathname];
      if (!route) throw new Error(`Unexpected request: ${url}`);
      return route(body);
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

const tokens = (): Response =>
  Response.json({
    accessToken: "access-token",
    accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    refreshToken: "refresh-token",
    organizationId: "org-1",
  });

let states: SigninState[] = [];
let signedIn = 0;
let auth: ReturnType<typeof createAuthService>;
const originalConsoleError = console.error;

beforeEach(() => {
  requests.length = 0;
  logged.length = 0;
  states = [];
  signedIn = 0;
  routes = {};
  // The logger writes to the console: capture it to prove no secret is logged.
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  auth = createAuthService({
    config: { apiOrigin: "https://api.example.com", clientId: "desktop-test", consoleUrl: "https://console.example.com", signinTemplate: "console-split" },
    redirectUri: "http://localhost:47813/callback",
    startLoopback: async () => {},
    stopLoopback: () => {},
    events: {
      onSignedIn: () => { signedIn += 1; },
      onSignedOut: () => {},
      onSigninState: (state) => states.push(state),
    },
  });
});

afterEach(() => {
  auth.dispose();
  console.error = originalConsoleError;
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}

const settled = (): boolean => signedIn > 0 || states.some((state) => state.status === "error" || state.status === "code_sent");

test("requestEmailCode posts the e-mail and locale, then reports code_sent with the address", async () => {
  routes["/api/auth/login/code"] = () => Response.json({ sent: true });
  auth.requestEmailCode("member@example.com", "en");
  await waitFor(settled);
  expect(requests).toEqual([{ url: "https://api.example.com/api/auth/login/code", body: { email: "member@example.com", locale: "en" } }]);
  expect(states).toEqual([{ status: "sending" }, { status: "code_sent", email: "member@example.com" }]);
  expect(auth.isSignedIn()).toBe(false);
});

test("requestEmailCode reports the API refusal by its code (cooldown)", async () => {
  routes["/api/auth/login/code"] = () =>
    Response.json({ error: { code: "EMAIL_LOGIN_CODE_COOLDOWN", message: "Patientez." } }, { status: 429 });
  auth.requestEmailCode("member@example.com", "fr");
  await waitFor(settled);
  expect(states.map((state) => state.status)).toEqual(["sending", "error"]);
  expect(states[1]).toMatchObject({ status: "error", code: "EMAIL_LOGIN_CODE_COOLDOWN" });
});

test("verifyEmailCode runs PKCE through /native/code/verify, exchanges the code and signs in", async () => {
  routes["/api/auth/native/code/verify"] = () => Response.json({ code: "native-auth-code", redirectUri: "http://localhost:47813/callback" });
  routes["/api/auth/native/token"] = () => tokens();
  auth.verifyEmailCode("member@example.com", "012345");
  await waitFor(settled);

  expect(signedIn).toBe(1);
  expect(auth.isSignedIn()).toBe(true);
  expect(states).toEqual([{ status: "verifying" }]);
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.example.com/api/auth/native/code/verify",
    "https://api.example.com/api/auth/native/token",
  ]);
  const verify = requests[0]!.body;
  expect(verify).toMatchObject({
    email: "member@example.com",
    code: "012345",
    redirectUri: "http://localhost:47813/callback",
    clientId: "desktop-test",
  });
  expect(verify.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const exchange = requests[1]!.body;
  expect(exchange).toMatchObject({ grantType: "authorization_code", code: "native-auth-code", redirectUri: "http://localhost:47813/callback" });
  // The verifier goes to the exchange only, and matches the challenge sent first.
  const { createHash } = await import("node:crypto");
  expect(createHash("sha256").update(String(exchange.codeVerifier)).digest("base64url")).toBe(String(verify.codeChallenge));
  expect(verify).not.toHaveProperty("codeVerifier");
});

test("verifyEmailCode: a 401 EMAIL_LOGIN_CODE_INVALID is an error state, no exchange, no session, nothing secret logged", async () => {
  routes["/api/auth/native/code/verify"] = () =>
    Response.json({ error: { code: "EMAIL_LOGIN_CODE_INVALID", message: "Code invalide ou expiré." } }, { status: 401 });
  auth.verifyEmailCode("member@example.com", "999999");
  await waitFor(settled);

  expect(states.map((state) => state.status)).toEqual(["verifying", "error"]);
  expect(states[1]).toMatchObject({ status: "error", code: "EMAIL_LOGIN_CODE_INVALID", message: "Code invalide ou expiré. Demandez un nouveau code." });
  expect(requests).toHaveLength(1);
  expect(signedIn).toBe(0);
  expect(auth.isSignedIn()).toBe(false);
  expect(logged.join("\n")).toContain("e-mail code sign-in failed: API 401 EMAIL_LOGIN_CODE_INVALID");
  expect(logged.join("\n")).not.toContain("member@example.com");
  expect(logged.join("\n")).not.toContain("999999");
});

test("verifyEmailCode: a network failure is the NETWORK error state", async () => {
  routes["/api/auth/native/code/verify"] = () => {
    throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
  };
  auth.verifyEmailCode("member@example.com", "012345");
  await waitFor(settled);
  expect(states.map((state) => state.status)).toEqual(["verifying", "error"]);
  expect(states[1]).toMatchObject({ status: "error", code: "NETWORK" });
  expect(auth.isSignedIn()).toBe(false);
});

test("verifyEmailCode: a success without a code is BAD_RESPONSE, never a token exchange", async () => {
  routes["/api/auth/native/code/verify"] = () => Response.json({ ok: true });
  auth.verifyEmailCode("member@example.com", "012345");
  await waitFor(settled);
  expect(states[1]).toMatchObject({ status: "error", code: "BAD_RESPONSE" });
  expect(requests).toHaveLength(1);
});

test("cancel drops a code check in flight: back to idle, its late answer signs nobody in", async () => {
  let answer: (response: Response) => void = () => {};
  routes["/api/auth/native/code/verify"] = () => new Promise<Response>((resolve) => { answer = resolve; });
  routes["/api/auth/native/token"] = () => tokens();
  auth.verifyEmailCode("member@example.com", "012345");
  await waitFor(() => requests.length === 1);
  auth.cancelSignIn();
  answer(Response.json({ code: "native-auth-code" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(states).toEqual([{ status: "verifying" }, { status: "idle" }]);
  expect(signedIn).toBe(0);
  expect(auth.isSignedIn()).toBe(false);
});
