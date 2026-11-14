import { Hono } from "hono";
import type { ActivationDto } from "@openedbot/contracts-api";
import { withTenant, type Db } from "@openedbot/platform-db";
import { readBotActivation } from "@openedbot/roster/application/product-export";
import { readRuntimeActivation } from "@openedbot/runtimes/application/runtime-activation";
import { readResultActivation } from "@openedbot/execution/application/product-export";
import { rememberWorkspaceActivation } from "@openedbot/identity/application/workspace-activation";
import type { AppVariables } from "./auth";

export function workspaceActivationRoutes(db: Db) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    const result = await withTenant(db, organizationId, async (tx) => {
      const [bots, runtime, successfulResult] = await Promise.all([
        readBotActivation(tx, organizationId),
        readRuntimeActivation(tx, organizationId),
        readResultActivation(tx, organizationId),
      ]);
      const current: ActivationDto = {
        ...bots,
        ...runtime,
        result: successfulResult,
      };
      return {
        ...current,
        ...(await rememberWorkspaceActivation(tx, organizationId, current)),
      };
    });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  return routes;
}
