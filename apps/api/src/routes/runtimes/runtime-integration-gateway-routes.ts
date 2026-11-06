import { Hono } from "hono";
import { type HermesGatewayRestartJob, type HermesGatewayStatus } from "@openedbot/hermes";
import type { RuntimeGatewayRestartDto, RuntimeGatewayStatusDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError } from "../../interfaces/http/http-error";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import { SESSION_ID_PATTERN } from "./runtime-integration-constants";
import { publicWriteError, withDeadline } from "./runtime-integration-public";
import { RELAY_FEATURE_GATEWAY_RESTART } from "@openedbot/contracts-connector/features";

/** L’état du gateway Hermes et son redémarrage. */
export function runtimeGatewayRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const { timeoutMs, invalidateIntegrationReads, requireWritableRuntime } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * L'état du gateway, et le SEUL redémarrage que le lien porte.
   *
   * Le gateway ne lit ses serveurs MCP qu'à son démarrage : toute écriture MCP
   * : ajout, installation, autorisation, retrait : est invisible aux runs
   * jusqu'à ce qu'il redémarre. L'hôte le dit par un marqueur, jamais par une
   * supposition, et le redémarrage est un job qu'il prouve sur `/health`.
   */
  routes.get("/integrations/gateway", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_GATEWAY_RESTART);
    try {
      return context.json<RuntimeGatewayStatusDto>(publicGatewayStatus(await withDeadline(client.gatewayStatus(), timeoutMs)));
    } catch (error) {
      throw publicWriteError(error);
    }
  });

  routes.post("/integrations/gateway/restart", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_GATEWAY_RESTART);
    try {
      return context.json<RuntimeGatewayRestartDto>(publicGatewayRestart(await client.gatewayRestart()), 202);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
  });

  routes.get("/integrations/gateway/restart/:job", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const jobId = context.req.param("job");
    if (!SESSION_ID_PATTERN.test(jobId)) {
      throw new HttpError(404, "GATEWAY_RESTART_NOT_FOUND", "Ce redémarrage n’existe plus.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_GATEWAY_RESTART);
    try {
      return context.json<RuntimeGatewayRestartDto>(publicGatewayRestart(await client.gatewayRestartPoll(jobId)));
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
  });

  return routes;
}

function publicGatewayRestart(job: HermesGatewayRestartJob): RuntimeGatewayRestartDto {
  return {
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    expiresAt: job.expiresAt,
  };
}

function publicGatewayStatus(status: HermesGatewayStatus): RuntimeGatewayStatusDto {
  return {
    restartPending: status.restartPending,
    pendingSince: status.pendingSince,
    activeSince: status.activeSince,
    job: status.job === null ? null : publicGatewayRestart(status.job),
  };
}
