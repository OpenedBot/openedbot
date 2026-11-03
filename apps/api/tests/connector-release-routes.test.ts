import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { ConnectorReleaseDto, ConnectorReleaseResponse } from "@openedbot/contracts-api";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { connectorReleaseRoutes } from "../src/routes/runtimes/connector-release-routes";

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

const release: ConnectorReleaseDto = {
  version: "v0.5.9",
  publishedAt: "2026-10-12T00:27:03.000Z",
  notes: "### Le marqueur survit",
  url: "https://docs.openedbot.app/docs/edge-setup",
};

function fakeDb(calls: string[], bindings: unknown[][], seen = false): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push(sql);
    bindings.push(values);
    if (sql.startsWith("select 1 as seen")) return Promise.resolve(seen ? [{ seen: 1 }] : []);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(query);
  return query;
}

function mount(db: SQL, auth: AuthContext = owner, current: ConnectorReleaseDto | null = release): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", connectorReleaseRoutes(db, { current: () => current }));
  return app;
}

describe("GET /connector-release", () => {
  test("hands the release, the receipt and the two commands, read as the member", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await mount(fakeDb(calls, bindings, true)).request("/connector-release");
    expect(response.status).toBe(200);
    expect(await response.json() as ConnectorReleaseResponse).toEqual({
      release,
      seen: true,
      upgradeCommand: "sudo edge-setup upgrade --yes",
      autoUpgradeCommand: "sudo edge-setup auto-upgrade enable --yes",
    });
    expect(calls.some((sql) => sql.includes("set_config('app.authenticating_user_id'"))).toBe(true);
  });

  test("no release read yet: nothing to announce, no query", async () => {
    const calls: string[] = [];
    const response = await mount(fakeDb(calls, []), owner, null).request("/connector-release");
    expect((await response.json() as ConnectorReleaseResponse).release).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a member who cannot operate the workspace is refused", async () => {
    const response = await mount(fakeDb([], []), { ...owner, role: "member" }).request("/connector-release");
    expect(response.status).toBe(403);
  });
});

describe("POST /connector-release/seen", () => {
  test("stores a stable version for this member and this organization", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const response = await mount(fakeDb(calls, bindings)).request("/connector-release/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "0.5.9" }),
    });
    expect(response.status).toBe(204);
    const index = calls.findIndex((sql) => sql.startsWith("insert into runtime_connector_release_seen"));
    expect(bindings[index]).toEqual(["org-1", "user-1", "v0.5.9"]);
  });

  test("anything but vX.Y.Z is refused", async () => {
    const response = await mount(fakeDb([], [])).request("/connector-release/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "latest" }),
    });
    expect(response.status).toBe(400);
  });
});
