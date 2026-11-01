import { expect, mock, test } from "bun:test";

const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
const states: Array<{ status: string; code?: string }> = [];
let signedIn = false;

// mock.module is process-wide in Bun: list every export the other desktop
// tests import from electron, or a later file sees a module without them.
mock.module("electron", () => ({
  app: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  nativeTheme: { themeSource: "system" },
  net: {
    fetch: async (input: string, init: { body?: unknown }) => {
      const url = String(input);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/api/auth/native/authorize")) {
        return body.emailCode === undefined
          ? Response.json({ status: "code_required" }, { status: 202 })
          : Response.json({ code: "native-auth-code", redirectUri: "http://localhost:47813/callback" });
      }
      if (url.endsWith("/api/auth/native/token")) {
        return Response.json({
          accessToken: "access-token",
          accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          refreshToken: "refresh-token",
          organizationId: "org-1",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
}));

const { createAuthService } = await import("../src/main/auth");

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}

test("password auth waits for the e-mail code, then exchanges the native code", async () => {
  requests.length = 0;
  states.length = 0;
  signedIn = false;
  const auth = createAuthService({
    config: {
      apiOrigin: "https://api.example.com",
      clientId: "desktop-test",
      consoleUrl: "https://console.example.com",
      signinTemplate: "console-split",
    },
    redirectUri: "http://localhost:47813/callback",
    startLoopback: async () => {},
    stopLoopback: () => {},
    events: {
      onSignedIn: () => { signedIn = true; },
      onSignedOut: () => {},
      onSigninState: (state) => states.push({ status: state.status, ...(state.status === "error" ? { code: state.code } : {}) }),
    },
  });

  try {
    auth.signInWithPassword({ email: "member@example.com", password: "password-value" });
    await waitFor(() => states.some((state) => state.status === "code_required"));
    expect(auth.isSignedIn()).toBe(false);
    expect(signedIn).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.com/api/auth/native/authorize");
    expect(requests[0]?.body).not.toHaveProperty("emailCode");

    auth.signInWithPassword({ email: "member@example.com", password: "password-value", emailCode: "012345" });
    await waitFor(() => signedIn);
    expect(auth.isSignedIn()).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.body.emailCode).toBe("012345");
    expect(requests[2]?.url).toBe("https://api.example.com/api/auth/native/token");
    expect(states.filter((state) => state.status === "code_required")).toHaveLength(1);
  } finally {
    auth.dispose();
  }
});
