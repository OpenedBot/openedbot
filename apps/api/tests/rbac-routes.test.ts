import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { requireRole } from "../src/routes/identity/auth";
import { botRoutes, sectionRoutes } from "../src/routes/roster/bot-routes";
import { approvalRoutes } from "../src/routes/conversation/conversation-routes";
import { groupRoutes } from "../src/routes/roster/group-routes";
import { HttpError } from "../src/interfaces/http/http-error";
import { botRoutineRoutes, groupRoutineRoutes, routineRoutes } from "../src/routes/execution/routine-routes";
import { botPermissionGrantRoutes } from "../src/routes/roster/bot-permission-grant-routes";
import { runtimePermissionRoutes } from "../src/routes/runtimes/runtime-permission-routes";

// Un member ne doit jamais franchir requireRole sur une mutation privilégiée.
// Comme requireRole s'exécute avant tout accès base, un db/config factice suffit:
// un 403 prouve que la garde court-circuite avant la moindre requête.
const member: AuthContext = {
  sessionId: "s",
  organizationId: "00000000-0000-4000-8000-000000000201",
  userId: "u",
  role: "member",
  kind: "web",
  credentialHash: "h",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = {} as any;

function mount(router: Hono<{ Variables: AppVariables }>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", member);
    await next();
  });
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500),
  );
  app.route("/", router);
  return app;
}

describe("RBAC : un member est refusé sur les mutations privilégiées", () => {
  const cases: Array<{ name: string; app: Hono<{ Variables: AppVariables }>; method: string; path: string }> = [
    { name: "création de bot", app: mount(botRoutes(stub, stub)), method: "POST", path: "/" },
    { name: "modification de bot", app: mount(botRoutes(stub, stub)), method: "PATCH", path: "/bot-1" },
    { name: "suppression de bot", app: mount(botRoutes(stub, stub)), method: "DELETE", path: "/bot-1" },
    { name: "création de section", app: mount(sectionRoutes(stub)), method: "POST", path: "/" },
    { name: "modification de section", app: mount(sectionRoutes(stub)), method: "PATCH", path: "/sec-1" },
    { name: "suppression de section", app: mount(sectionRoutes(stub)), method: "DELETE", path: "/sec-1" },
    { name: "création de groupe", app: mount(groupRoutes(stub)), method: "POST", path: "/" },
    { name: "modification de groupe", app: mount(groupRoutes(stub)), method: "PATCH", path: "/grp-1" },
    { name: "suppression de groupe", app: mount(groupRoutes(stub)), method: "DELETE", path: "/grp-1" },
    { name: "création de routine", app: mount(botRoutineRoutes(stub)), method: "POST", path: "/bot-1/routines" },
    { name: "création de routine de salon", app: mount(groupRoutineRoutes(stub)), method: "POST", path: "/grp-1/routines" },
    { name: "lancement manuel de routine", app: mount(routineRoutes(stub, false)), method: "POST", path: "/rt-1/runs" },
    { name: "modification de routine", app: mount(routineRoutes(stub, false)), method: "PATCH", path: "/rt-1" },
    { name: "suppression de routine", app: mount(routineRoutes(stub, false)), method: "DELETE", path: "/rt-1" },
    { name: "réponse à une approbation", app: mount(approvalRoutes(stub)), method: "POST", path: "/ap-1/respond" },
    { name: "liste des autorisations permanentes", app: mount(botPermissionGrantRoutes(stub)), method: "GET", path: "/bot-1/permission-grants" },
    { name: "retrait d'une autorisation permanente", app: mount(botPermissionGrantRoutes(stub)), method: "POST", path: "/bot-1/permission-grants/g-1/revoke" },
    { name: "lecture de l'interrupteur terminal", app: mount(runtimePermissionRoutes(stub)), method: "GET", path: "/rt-1/permission-settings" },
    { name: "écriture de l'interrupteur terminal", app: mount(runtimePermissionRoutes(stub)), method: "PUT", path: "/rt-1/permission-settings" },
  ];

  for (const { name, app, method, path } of cases) {
    test(`${name} → 403 ROLE_REQUIRED`, async () => {
      const response = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({}),
      });
      expect(response.status).toBe(403);
      const payload = (await response.json()) as { error: { code: string; message?: string } };
      expect(payload.error.code).toBe("ROLE_REQUIRED");
      if (name.includes("routine")) {
        expect(payload.error.message).toBe("Les routines sont réservées aux administrateurs de l’organisation.");
      }
    });
  }
});

describe("requireRole", () => {
  test("laisse passer owner et admin, refuse member", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(() => requireRole({ ...member, role }, ["owner", "admin"])).not.toThrow();
    }
    expect(() => requireRole(member, ["owner", "admin"])).toThrow(/Droits insuffisants/);
  });
});
