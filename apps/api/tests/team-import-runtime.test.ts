import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import type { HermesHostProfile } from "@openedbot/hermes";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import { HttpError } from "../src/interfaces/http/http-error";
import { teamImportRoutes } from "../src/routes/portability/team-import-routes";
import type { BlobStore } from "../src/infrastructure/blob-store";
import type { RuntimeProfileImportDto } from "@openedbot/contracts-api";

const owner: AuthContext = {
  sessionId: "session-1", organizationId: "org-1", userId: "user-1", role: "owner",
  kind: "web", credentialHash: "credential",
};

const scout: HermesHostProfile = {
  name: "scout",
  displayName: "Scout",
  title: "Scout",
  description: "Find sources.",
  soul: "# Scout\nA researcher.",
  model: { default: "claude-sonnet-4", provider: "anthropic" },
  uiMeta: {
    title: "Scout", color: "blue", shape: "circle", imageKind: "generated",
    hidden: false, pinned: true, sectionId: null, groups: ["newsroom"], created: null,
  },
  hasAvatar: false,
  routines: [
    { name: "Morning brief", schedule: "30 8 * * 1,2,3,4,5", prompt: "Prepare the brief.", enabled: true, deliver: true, model: null },
    { name: "Every half hour", schedule: "every 30m", prompt: "Ping.", enabled: false, deliver: true, model: null },
  ],
  skills: [{ name: "research", enabled: true }],
  toolsets: [{ name: "web", enabled: true }],
  mcpServers: [],
};

const editor: HermesHostProfile = {
  ...scout,
  name: "editor",
  displayName: "Editor",
  title: "Editor",
  description: "Edit.",
  soul: "# Editor",
  uiMeta: { ...scout.uiMeta!, pinned: false, groups: ["newsroom"] },
  routines: [],
  skills: [],
  toolsets: [],
};

function fakeDb(options: { section?: boolean; already?: string[] } = {}) {
  const sql: string[] = [];
  const values: unknown[][] = [];
  const tx = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    values.push(parameters);
    const statement = [...strings].join(" ");
    sql.push(statement);
    if (statement.includes("pg_advisory_xact_lock")) return [];
    if (statement.includes("select hermes_profile")) {
      return (options.already ?? []).map((hermesProfile) => ({ hermesProfile }));
    }
    if (statement.includes("select id from sections")) return options.section === false ? [] : [{ id: "section-1" }];
    if (statement.includes("coalesce(max(position)")) return [{ next: 0 }];
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => Promise<unknown>) => Promise<unknown> }).begin = async (callback) =>
    callback(tx);
  return { db: tx, sql, values };
}

function mount(options: {
  profiles?: HermesHostProfile[];
  features?: string[] | null;
  already?: string[];
  section?: boolean;
  runtime?: boolean;
  role?: AuthContext["role"];
} = {}) {
  const { db } = fakeDb({ already: options.already, section: options.section });
  const blobs: BlobStore = {
    driver: "file",
    metrics: { snapshot: () => ({ writes: 0, deletes: 0, bytesWritten: 0, bytesDeleted: 0, errors: 0 }) } as BlobStore["metrics"],
    put: async () => undefined,
    get: async () => new Blob(),
    delete: async () => undefined,
    deliveryUrl: () => null,
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { ...owner, role: options.role ?? "owner" });
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  app.route("/", teamImportRoutes(db, {} as ApiConfig, {
    blobs,
    readRuntime: (async () => (options.runtime === false ? null : { id: "runtime-1", client: {} })) as never,
    clientFactory: () => ({
      probeProfileIsolation: async () => "isolated" as const,
      modelOptions: async () => ({ provider: "anthropic", model: "claude-sonnet-4", providers: [{ slug: "anthropic", name: "Anthropic", isCurrent: true, authenticated: true, authType: null, warning: null, models: [{ id: "claude-sonnet-4", fast: false, reasoning: false }] }] }),
      hostCapabilities: async () => options.features === undefined ? ["profile_inventory"] : options.features,
      hostProfileInventory: async () => ({ profiles: options.profiles ?? [scout, editor] }),
      hostProfileAvatar: async () => ({ contentType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) }),
    }),
  }));
  return app;
}

function post(app: Hono<{ Variables: AppVariables }>, body: Record<string, unknown>) {
  return app.request("/runtime", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/team-imports/runtime", () => {
  test("importe les profils, routines cron en pause, et liste les limitations", async () => {
    const app = mount();
    const response = await post(app, { profiles: ["scout", "editor"] });
    expect(response.status).toBe(201);
    const body = await response.json() as RuntimeProfileImportDto;
    expect(body.imported.map((row) => row.slug)).toEqual(["scout", "editor"]);
    expect(body.routines).toHaveLength(2);
    expect(body.routines[0]!.schedule).toBe("30 8 * * 1,2,3,4,5");
    expect(body.groups).toEqual([expect.objectContaining({ name: "newsroom", memberSlugs: ["scout", "editor"] })]);
    expect(body.limitations.some((item) => item.startsWith("routine-schedule-every-anchored:scout"))).toBe(true);
    expect(body.limitations.some((item) => item.startsWith("capabilities-live-on-profile:scout"))).toBe(true);
    expect(body.limitations.some((item) => item.startsWith("capabilities-live-on-profile:"))).toBe(true);
    expect(body.skipped).toEqual([]);
  });

  test("409 PROFILE_ALREADY_IMPORTED si un profil est déjà lié", async () => {
    const app = mount({ already: ["scout"] });
    const response = await post(app, { profiles: ["scout"] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_ALREADY_IMPORTED" } });
  });

  test("404 PROFILE_INVENTORY_UNAVAILABLE si l'hôte n'annonce pas la feature", async () => {
    const app = mount({ features: ["mcp_management"] });
    const response = await post(app, { profiles: ["scout"] });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_INVENTORY_UNAVAILABLE" } });
  });

  test("skip un profil absent de l'inventaire", async () => {
    const app = mount({ profiles: [editor] });
    const response = await post(app, { profiles: ["ghost"] });
    expect(response.status).toBe(201);
    const body = await response.json() as RuntimeProfileImportDto;
    expect(body.imported).toEqual([]);
    expect(body.skipped).toEqual([{ slug: "ghost", reason: "not-in-inventory" }]);
  });

  test("refuse default et un membre", async () => {
    const app = mount();
    expect((await post(app, { profiles: ["default"] })).status).toBe(400);
    const member = mount({ role: "member" });
    expect((await post(member, { profiles: ["scout"] })).status).toBe(403);
  });
});
