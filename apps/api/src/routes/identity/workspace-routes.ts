import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { CreatedOrganizationDto, OrganizationKind } from "@openedbot/contracts-api";
import { listAccountWorkspaces } from "@openedbot/identity/application/workspaces";
import { createOrganization, type ApiEnvironment } from "@openedbot/identity/sql/accounts";
import { attachSessionOrganization } from "@openedbot/identity/sql/sessions";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  fleetWorkspacesEnabled,
  type ProductFeatureSource,
} from "../../application/product-features";
import type { AppVariables } from "./auth";

export type WorkspaceRouteOptions = {
  agencyAvailable: ProductFeatureSource;
  billingEnforced: boolean;
  environment: ApiEnvironment;
};

export function workspaceRoutes(db: Db, options: WorkspaceRouteOptions): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  routes.get("/workspaces", async (c) => {
    const { userId } = c.get("auth");
    const agencyAvailable = await fleetWorkspacesEnabled(options.agencyAvailable, c.get("auth"));
    const workspaces = await listAccountWorkspaces(db, userId, agencyAvailable);
    return c.json({ userId, agencyAvailable, workspaces });
  });

  /**
   * « Définir votre organisation » : la seule porte qui crée une organisation.
   * Une session encore sans organisation (web, ou native du desktop) y est
   * rattachée dans la foulée, pour que la requête suivante ouvre directement
   * le nouvel espace. Une session qui en a déjà une n'est pas touchée.
   */
  routes.post("/organizations", async (c) => {
    const auth = c.get("auth");
    const body = await jsonBody(c.req.raw);
    const kind = body.kind;
    if (kind !== "personal" && kind !== "agency") {
      throw new HttpError(400, "ORGANIZATION_KIND_INVALID", "Le type d’organisation doit être personnel ou agence.");
    }
    const agencyAvailable = await fleetWorkspacesEnabled(options.agencyAvailable, c.get("auth"));
    if (kind === "agency" && !agencyAvailable) {
      throw new HttpError(403, "AGENCY_DISABLED", "Le mode agence n’est pas disponible.");
    }
    const name = assertString(body.name, "Le nom de l’organisation", { min: 1, max: 80 }).trim();
    if (!name) throw new HttpError(400, "ORGANIZATION_NAME_REQUIRED", "Donnez un nom à l’organisation.");
    const created: CreatedOrganizationDto = await createOrganization(
      db, { kind: kind as OrganizationKind, name }, auth.userId, options.environment, options.billingEnforced,
    );
    await attachSessionOrganization(db, auth.credentialHash, auth.sessionId, created.organizationId);
    return c.json(created, 201);
  });

  return routes;
}
