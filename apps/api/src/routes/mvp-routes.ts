import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { AppVariables } from "./identity/auth";
import { workspacePreferencesRoutes } from "./notifications/workspace-preferences-routes";
import { workspaceActivationRoutes } from "./identity/workspace-activation-routes";
import { conversationFilesRoutes } from "./conversation/conversation-files-routes";
import { productExportRoutes } from "./conversation/product-export-routes";

/** Authenticated product completion routes share the API's existing guards. */
export function mvpRoutes(db: Db) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route("/workspace-preferences", workspacePreferencesRoutes(db));
  routes.route("/activation", workspaceActivationRoutes(db));
  routes.route("/threads", conversationFilesRoutes(db));
  routes.route("/exports", productExportRoutes(db));
  return routes;
}
