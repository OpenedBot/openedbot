import { Hono } from "hono";
import type { ApnsConfigDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { readApnsDevice, registerApnsDevice, removeApnsDevice } from "@openedbot/notifications/application/apns-devices";
import { readApnsInstallationId, readApnsRegistrationInput } from "@openedbot/notifications/domain/apns";
import type { AppVariables, AuthContext } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

/** A registration body is three short strings; anything larger is not one. */
const MAX_REGISTRATION_BODY_BYTES = 4_096;

/**
 * iOS push (DEV-308), mounted at `/api/push/apns` behind the session gate:
 * native Bearer + `X-OHB-Organization`, like every tenant route. The device
 * belongs to (organization, user, installationId); the token is never
 * returned or logged.
 */
export function apnsDeviceRoutes(
  db: Db,
  config: Pick<ApiConfig, "apns" | "tokenEncryption">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/config", (context) => {
    const dto: ApnsConfigDto = { enabled: config.apns !== null };
    return context.json(dto);
  });

  routes.put("/devices/:installationId", async (context) => {
    const apns = requireApns(config);
    const auth = context.get("auth");
    requireMembership(auth);
    const installationId = readApnsInstallationId(context.req.param("installationId"));
    const input = readApnsRegistrationInput(
      await jsonBody(context.req.raw, MAX_REGISTRATION_BODY_BYTES),
      apns.bundleIds,
    );
    const dto = await registerApnsDevice(
      db,
      { organizationId: auth.organizationId, userId: auth.userId, installationId },
      input,
      config.tokenEncryption,
    );
    return context.json(dto);
  });

  routes.get("/devices/:installationId", async (context) => {
    const auth = context.get("auth");
    requireMembership(auth);
    const installationId = readApnsInstallationId(context.req.param("installationId"));
    return context.json(await readApnsDevice(db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      installationId,
    }));
  });

  // Not gated on configuration: a device registered before the key was
  // removed must still be revocable by its owner.
  routes.delete("/devices/:installationId", async (context) => {
    const auth = context.get("auth");
    requireMembership(auth);
    const installationId = readApnsInstallationId(context.req.param("installationId"));
    await removeApnsDevice(db, { organizationId: auth.organizationId, userId: auth.userId, installationId });
    return context.body(null, 204);
  });

  return routes;
}

function requireApns(config: Pick<ApiConfig, "apns">): NonNullable<ApiConfig["apns"]> {
  if (!config.apns) {
    throw new HttpError(404, "APNS_NOT_CONFIGURED", "Les notifications iOS ne sont pas configurées sur ce déploiement.");
  }
  return config.apns;
}

/**
 * A device hangs off a membership (FK, cascade). An agency mandate acts for a
 * client without one: it has no device to register there.
 */
function requireMembership(auth: AuthContext): void {
  if (auth.role === "agency") {
    throw new HttpError(403, "ROLE_REQUIRED", "Les notifications iOS sont réservées aux membres de l’espace.");
  }
}
