import { Hono } from "hono";
import type { BotRoutineToolDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { RoutineToolInstaller } from "./routine-tool-install";

export { routineToolUsesDevelopmentCallback } from "./routine-tool-install";

/**
 * « Programmer depuis le chat » of one bot (DEV-209, 0187). The tool is on by
 * default and installed by the API itself (`routine-tool-install.ts`); this
 * switch is the operator's opt-out, remembered even while the host is away.
 * Switching it records the choice, schedules a pass in the background and
 * answers at once with the status: a slow host never holds the request.
 */
export function botRoutineToolRoutes(installer: Pick<RoutineToolInstaller, "status" | "setSwitchedOff" | "schedule">): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  const status = async (organizationId: string, botId: string): Promise<BotRoutineToolDto> => {
    const state = await installer.status(organizationId, botId);
    if (!state) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    return state;
  };

  routes.get("/:botId/routine-tool", async (context) => {
    const auth = context.get("auth");
    return context.json<BotRoutineToolDto>(await status(auth.organizationId, context.req.param("botId")));
  });

  routes.put("/:botId/routine-tool", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "BODY_INVALID", "enabled doit être un booléen.");
    const botId = context.req.param("botId");
    await status(auth.organizationId, botId);
    await installer.setSwitchedOff(auth.organizationId, botId, !body.enabled, auth.userId);
    installer.schedule(auth.organizationId);
    return context.json<BotRoutineToolDto>(await status(auth.organizationId, botId));
  });

  return routes;
}
