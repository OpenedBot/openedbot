import { describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import { redirectGoogleCallback } from "../src/routes/identity/auth";

describe("Google OAuth callback redirect", () => {
  test("delegates the 303 to the Hono context that owns the session cookies", () => {
    const returnTo = "http://localhost:1420/login?redirect=%2F";
    const response = new Response(null, { status: 303, headers: { Location: returnTo } });
    const redirect = mock(() => response);
    const context = { redirect } as unknown as Context;

    expect(redirectGoogleCallback(context, returnTo)).toBe(response);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(returnTo, 303);
  });
});
