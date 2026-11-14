import { Hono } from "hono";
import type { WorkflowEmailPreferences } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { workspacePreferences } from "@openedbot/notifications/application/workspace-preferences";
import type { AppVariables } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

export function workspacePreferencesRoutes(db: Db) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await workspacePreferences(db, auth.organizationId, auth.userId),
    );
  });
  routes.patch("/", async (c) => {
    const body: unknown = await jsonBody(c.req.raw, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "INVALID_PREFERENCES", "Préférences invalides.");
    const fields = Object.entries(body);
    if (
      !fields.length ||
      fields.some(([key, value]) =>
        key === "locale"
          ? value !== "fr" && value !== "en"
          : !["approval", "completed", "failed", "checklistHidden"].includes(
              key,
            ) || typeof value !== "boolean",
      )
    ) {
      throw new HttpError(400, "INVALID_PREFERENCES", "Préférences invalides.");
    }
    const auth = c.get("auth");
    return c.json(
      await workspacePreferences(
        db,
        auth.organizationId,
        auth.userId,
        body as Partial<WorkflowEmailPreferences>,
      ),
    );
  });
  return routes;
}
