import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { AccountWorkspacesDto, CreatedOrganizationDto } from "@openedbot/contracts-api";
import { listAccountWorkspaces } from "@openedbot/identity/application/workspaces";
import { createOrganization, type ApiEnvironment } from "@openedbot/identity/application/accounts";
import { attachSessionOrganization } from "@openedbot/identity/application/sessions";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { AppVariables } from "./auth";

export type WorkspaceRouteOptions = {
  billingEnforced: boolean;
  environment: ApiEnvironment;
};

export function workspaceRoutes(db: Db, options: WorkspaceRouteOptions): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  routes.get("/workspaces", async (c) => {
    const { userId } = c.get("auth");
    const workspaces = await listAccountWorkspaces(db, userId);
    // `agencyAvailable` stays on the wire, always `false`, for installed consoles.
    const body: AccountWorkspacesDto = { userId, agencyAvailable: false, workspaces };
    return c.json(body);
  });

  /**
   * « Définir votre organisation »: the only door that creates an organization.
   * A session still without an organization (web, or native from the desktop) is
   * attached to it right away, so that the next request opens
   * the new workspace directly. A session that already has one is not touched.
   * `kind` is optional: installed consoles send `"personal"`; any other value is refused.
   */
  routes.post("/organizations", async (c) => {
    const auth = c.get("auth");
    const body = await jsonBody(c.req.raw);
    if (body.kind !== undefined && body.kind !== "personal") {
      throw new HttpError(400, "ORGANIZATION_KIND_INVALID", "Seul un espace personnel peut être créé.");
    }
    const name = assertString(body.name, "Le nom de l’organisation", { min: 1, max: 80 }).trim();
    if (!name) throw new HttpError(400, "ORGANIZATION_NAME_REQUIRED", "Donnez un nom à l’organisation.");
    const created: CreatedOrganizationDto = await createOrganization(
      db, { name }, auth.userId, options.environment, options.billingEnforced,
    );
    await attachSessionOrganization(db, auth.credentialHash, auth.sessionId, created.organizationId);
    return c.json(created, 201);
  });

  return routes;
}
