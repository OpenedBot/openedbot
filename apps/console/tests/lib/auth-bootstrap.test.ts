import { afterEach, describe, expect, test } from "bun:test";
import { api, ApiError, isUnauthorized, queryKeys } from "../../src/lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("cloud auth bootstrap", () => {
  test("does not send a stale organization header to auth/me", async () => {
    window.localStorage.setItem(
      "openedbot:cloud-session",
      JSON.stringify({ organizationId: "previous-organization", csrfToken: "previous-csrf" }),
    );

    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestInit = init;
      return Response.json({
        user: { id: "user-1", email: "user@example.test", displayName: null },
        organization: { id: "current-organization", slug: "current", name: "Current" },
        role: "owner",
      });
    }) as typeof fetch;

    await api.authMe();

    const headers = new Headers(requestInit?.headers);
    expect(headers.has("X-OpenedBot-Organization")).toBe(false);
    expect(queryKeys.authMe).toEqual(["auth", "me"]);
  });

  test("maps staff impersonation to an explicitly read-only web session", async () => {
    globalThis.fetch = (async () => Response.json({
      user: { id: "user-1", email: "user@example.test", displayName: null },
      organization: { id: "organization-1", slug: "current", name: "Current" },
      role: "owner",
      impersonation: { readOnly: true },
    })) as unknown as typeof fetch;

    const me = await api.authMe();
    expect(me.session).toEqual({
      role: "owner",
      canWrite: false,
      impersonation: { readOnly: true },
    });
  });

  test("treats AUTH_REQUIRED as an unauthenticated session", async () => {
    globalThis.fetch = (async (_input, _init) => Response.json(
      { error: { code: "AUTH_REQUIRED", message: "Authentification requise." } },
      { status: 401 },
    )) as typeof fetch;

    const error = new ApiError(401, "Authentification requise.", "AUTH_REQUIRED");
    expect(isUnauthorized(error)).toBe(true);
    await expect(api.authStatus()).resolves.toEqual({
      kind: "none",
      ssoEnabled: true,
      user: null,
      sessionId: null,
      reason: "AUTH_REQUIRED",
      mustChangePassword: false,
    });
  });
});

test("retains structured import error details from HTTP responses", async () => {
  globalThis.fetch = (async () => Response.json({ error: { code: "PROFILE_IMPORT_UNCONFIRMED", message: "Verify profiles", details: { unconfirmedProfiles: ["scout"] } } }, { status: 409 })) as unknown as typeof fetch;
  await expect(api.hermesImportJob("job-1")).rejects.toMatchObject({ code: "PROFILE_IMPORT_UNCONFIRMED", details: { unconfirmedProfiles: ["scout"] } });
});
