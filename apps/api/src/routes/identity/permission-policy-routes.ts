import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { AppVariables } from "./auth";
import { requireRole } from "./auth";
import { jsonBody } from "../../interfaces/http/http-error";
import { readPermissionPolicyInput, readPermissionPolicyView, savePermissionPolicy } from "@openedbot/identity/application/permission-policy";

/**
 * PERM2-8: `/api/organization/permissions`. Every member
 * reads the policy its bots run under; owners and admins write it. An agency
 * never reaches these routes (`agencyRequestAllowed` refuses every
 * `/api/organization*` path, D-5).
 */
export function permissionPolicyRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    return context.json(await readPermissionPolicyView(db, auth));
  });

  routes.put("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"], "Seuls le propriétaire et les administrateurs modifient cette politique.");
    const input = readPermissionPolicyInput(await jsonBody(context.req.raw));
    return context.json(await savePermissionPolicy(db, auth, input));
  });

  return routes;
}
