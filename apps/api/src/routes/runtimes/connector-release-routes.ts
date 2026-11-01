import { Hono } from "hono";
import type { ConnectorReleaseResponse } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { parseConnectorVersion } from "@openedbot/platform-config/connector-version";
import type { ConnectorReleaseFeed } from "@openedbot/runtime-link/application/connector-release-feed";
import { connectorReleaseSeen, markConnectorReleaseSeen } from "@openedbot/runtime-link/application/connector-release-seen";
import { requireOperator, type AppVariables } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

/**
 * The latest edge-setup release for the console's update dialog, and the
 * member's "seen" receipt (0109). openedbot never upgrades the host (release
 * boundary): the dialog only hands the owner the two commands below.
 */
export function connectorReleaseRoutes(db: Db, feed: Pick<ConnectorReleaseFeed, "current">): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/connector-release", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const release = feed.current();
    const seen = release ? await connectorReleaseSeen(db, auth.organizationId, auth.userId, release.version) : false;
    const body: ConnectorReleaseResponse = {
      release,
      seen,
      upgradeCommand: "sudo edge-setup upgrade --yes",
      autoUpgradeCommand: "sudo edge-setup auto-upgrade enable --yes",
    };
    return context.json(body);
  });

  routes.post("/connector-release/seen", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const version = parseConnectorVersion(typeof body.version === "string" ? body.version : null);
    if (!version) throw new HttpError(400, "VERSION_INVALID", "Version attendue : vX.Y.Z.");
    await markConnectorReleaseSeen(db, auth.organizationId, auth.userId, version);
    return context.body(null, 204);
  });

  return routes;
}
