import { isUuid, isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import type { RuntimePermissionSettingsDto } from "@openedbot/contracts-api";
import {
  readRuntimePermissionSettingsTx,
  setTerminalDangerAlwaysTx,
  type RuntimePermissionSettingsRow,
} from "@openedbot/runtimes/application/permission-settings";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { logEvent } from "@openedbot/platform-observability";
import { requireOperator, type AppVariables } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { permissionActor } from "../roster/bot-permission-grant-routes";

/**
 * PERM2-4, D-3: the runtime switch "dangerous commands: always allow", for
 * every bot of the runtime. Owner, admin and mandated agency, like the other
 * runtime settings. A write raises the revision of every bot of the
 * organization (0140); the answer is the stored row read back.
 */
export function runtimePermissionRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:runtimeId/permission-settings", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = readUuid(context.req.param("runtimeId"));
    const row = await withTenant(db, auth.organizationId, (tx) => readRuntimePermissionSettingsTx(tx, auth.organizationId, runtimeId));
    if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
    return context.json(settingsDto(row));
  });

  routes.put("/:runtimeId/permission-settings", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = readUuid(context.req.param("runtimeId"));
    const body = await jsonBody(context.req.raw);
    if (typeof body.terminalDangerAlways !== "boolean") {
      throw new HttpError(400, "RUNTIME_PERMISSION_SETTINGS_INVALID", "terminalDangerAlways doit être un booléen.");
    }
    const value = body.terminalDangerAlways;
    const row = await withTenant(db, auth.organizationId, async (tx) => {
      const written = await setTerminalDangerAlwaysTx(tx, { organizationId: auth.organizationId, runtimeId, value, actor: permissionActor(auth) });
      if (!written) return null;
      if (written.changed) logEvent("runtime.terminal_switch", { runtimeId, on: value, actorKind: auth.actingFleetId ? "agency" : "member" });
      return readRuntimePermissionSettingsTx(tx, auth.organizationId, runtimeId);
    });
    if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
    // A write is proven by the read-back, never by the statement's success.
    if (row.terminalDangerAlways !== value) {
      throw new HttpError(409, "RUNTIME_PERMISSION_SETTINGS_NOT_SAVED", "Le réglage n’a pas été enregistré. Réessayez.");
    }
    return context.json(settingsDto(row));
  });

  return routes;
}

function settingsDto(row: RuntimePermissionSettingsRow): RuntimePermissionSettingsDto {
  return { ...row, updatedAt: row.updatedAt ? isoInstant(row.updatedAt) : null };
}

function readUuid(value: string | undefined): string {
  if (!value || !isUuid(value)) throw new HttpError(400, "ID_INVALID", "Identifiant invalide.");
  return value.toLowerCase();
}
