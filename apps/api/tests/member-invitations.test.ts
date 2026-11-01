import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { memberInvitationRoutes } from "../src/routes/identity/member-invitation-routes";

function app(): Hono {
  const server = new Hono();
  server.route("/api/invite/member", memberInvitationRoutes({} as Db, { environment: "test", trustProxy: false }));
  server.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
  return server;
}

describe("member invitation public routes", () => {
  test("an invalid token is unavailable and never cacheable", async () => {
    const response = await app().request("http://localhost/api/invite/member/not-a-token");
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "MEMBER_INVITATION_UNAVAILABLE" } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("registration validates the password before looking up the invitation", async () => {
    const response = await app().request("http://localhost/api/invite/member/not-a-token/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "short" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "PASSWORD_INVALID" } });
  });
});
