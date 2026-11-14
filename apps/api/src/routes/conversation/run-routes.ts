import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { requestRunCancellationTx } from "@openedbot/execution/application/run-cancellation";
import { settleCancelledHandoffsTx } from "./conversation-followup";

export function runRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/:runId/cancel", async (context) => {
    const auth = context.get("auth");
    const rows = await withTenant(db, auth.organizationId, async (tx) => {
      const uncertain = await tx<Array<{ id: string }>>`
        select id from runs where organization_id = ${auth.organizationId}
          and id = ${context.req.param("runId")} and status = 'unknown'
         for update
      `;
      if (uncertain[0]) {
        throw new HttpError(409, "WORKFLOW_REVIEW_REQUIRED", "Réconciliez ou abandonnez le workflow incertain.");
      }
      const cancelled = await requestRunCancellationTx(
        tx,
        auth.organizationId,
        context.req.param("runId"),
        { code: "CANCELLED_BY_USER", message: "Run annulé." },
      );
      await settleCancelledHandoffsTx(
        tx,
        auth.organizationId,
        cancelled.filter((run) => run.status === "cancelled"),
      );
      return cancelled;
    });
    if (!rows[0]) throw new HttpError(409, "RUN_NOT_CANCELLABLE", "Ce run ne peut plus être annulé.");
    return context.body(null, 204);
  });
  return routes;
}
