import { Hono } from "hono";
import type { BotComputerDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../../routes/identity/auth";
import { requireRole } from "../../routes/identity/auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "./http-error";
import {
  ComputerProviderError,
  type ComputerProvider,
  type ComputerProviderStatus,
} from "../../infrastructure/computer-provider";
import { logger } from "@openedbot/platform-observability";

type BotIdentity = { id: string; name: string; archivedAt: Date | null };

export function computerRoutes(
  db: Db,
  provider: ComputerProvider,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // Viewer URLs and screenshots can contain an authenticated desktop. They
  // must never enter browser/proxy caches or leak through a Referer header.
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store, private");
    context.header("Pragma", "no-cache");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  routes.get("/:botId/computer", async (context) => {
    const auth = context.get("auth");
    const bot = await readBot(db, auth.organizationId, context.req.param("botId"));
    const workspaceKey = `${auth.organizationId}:${bot.id}`;
    const canManage = auth.role === "owner" || auth.role === "admin";
    try {
      return context.json(toDto(bot.id, canManage, provider.kind, await provider.status(workspaceKey)));
    } catch (error) {
      // A provider outage is a Computer state, not a 500 that leaves the panel
      // with no useful lifecycle observation.
      if (error instanceof ComputerProviderError) {
        logProviderFailure("status", bot.id, error);
        return context.json(toDto(bot.id, canManage, provider.kind, {
          configured: provider.kind !== "disabled",
          state: "error",
          providerState: null,
        }));
      }
      throw error;
    }
  });

  routes.post("/:botId/computer/start", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const bot = await readBot(db, auth.organizationId, context.req.param("botId"));
    if (bot.archivedAt) throw new HttpError(409, "BOT_ARCHIVED", "Restaurez ce bot avant de démarrer son ordinateur.");
    try {
      const status = await withComputerLifecycleLock(db, auth.organizationId, bot.id, () =>
        provider.start(`${auth.organizationId}:${bot.id}`, bot.name));
      return context.json(toDto(bot.id, true, provider.kind, status));
    } catch (error) {
      throw mapProviderError("start", bot.id, error);
    }
  });

  routes.post("/:botId/computer/open", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const bot = await readBot(db, auth.organizationId, context.req.param("botId"));
    try {
      return context.json(await provider.open(`${auth.organizationId}:${bot.id}`));
    } catch (error) {
      throw mapProviderError("open", bot.id, error);
    }
  });

  routes.post("/:botId/computer/capture", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const bot = await readBot(db, auth.organizationId, context.req.param("botId"));
    try {
      return context.json(await provider.capture(`${auth.organizationId}:${bot.id}`));
    } catch (error) {
      throw mapProviderError("capture", bot.id, error);
    }
  });

  routes.post("/:botId/computer/stop", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const bot = await readBot(db, auth.organizationId, context.req.param("botId"));
    try {
      const status = await withComputerLifecycleLock(db, auth.organizationId, bot.id, () =>
        provider.stop(`${auth.organizationId}:${bot.id}`));
      return context.json(toDto(bot.id, true, provider.kind, status));
    } catch (error) {
      throw mapProviderError("stop", bot.id, error);
    }
  });

  return routes;
}

/**
 * Cross-replica lifecycle ordering. Provider calls are deliberately inside the
 * transaction: the advisory lock must remain held until the remote mutation is
 * observed complete, otherwise another replica can overtake it between the
 * Box request and its readiness/stop confirmation.
 */
async function withComputerLifecycleLock<T>(
  db: Db,
  organizationId: string,
  botId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withTenant(db, organizationId, async (tx) => {
    await tx`
      select pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${`ohb-computer:${botId}`})
      )
    `;
    return operation();
  });
}

async function readBot(db: Db, organizationId: string, botId: string): Promise<BotIdentity> {
  const bot = await withTenant(db, organizationId, async (tx) => {
    const rows = await tx<BotIdentity[]>`
      select id, name, archived_at as "archivedAt"
        from bots
       where organization_id = ${organizationId} and id = ${botId}
       limit 1
    `;
    return rows[0] ?? null;
  });
  if (!bot) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return bot;
}

export function toDto(
  botId: string,
  canManage: boolean,
  kind: ComputerProvider["kind"],
  status: ComputerProviderStatus,
): BotComputerDto {
  if (!status.configured || kind === "disabled") {
    return {
      botId,
      canManage,
      provider: null,
      observation: {
        capability: { supported: false, reason: "COMPUTER_CAPABILITY_UNSUPPORTED" },
      },
      agentControl: {
        status: "unavailable",
        reason: "COMPUTER_PROVIDER_DISABLED",
      },
      providerState: null,
    };
  }
  return {
    botId,
    canManage,
    provider: kind,
    observation: {
      capability: { supported: true, canOpen: true, canCapture: true },
      status: status.state === "error"
        ? { status: "error", reason: "COMPUTER_BACKEND_ERROR" }
        : { status: status.state },
    },
    // Box is currently an operator-facing desktop. Hermes' native
    // computer_use targets the gateway host, and /v1/runs has no run-scoped
    // backend/MCP binding, so claiming agent control here would target the
    // wrong machine or share credentials across bots.
    agentControl: {
      status: "unavailable",
      reason: "COMPUTER_AGENT_CONTROL_NOT_BOUND",
    },
    providerState: status.providerState,
  };
}

function mapProviderError(action: string, botId: string, error: unknown): HttpError {
  if (error instanceof ComputerProviderError) {
    logProviderFailure(action, botId, error);
    return new HttpError(
      error.status,
      error.code,
      error.message,
      error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {},
    );
  }
  const reference = crypto.randomUUID();
  logger.error(
    { event: "api.computer_provider_unexpected", action, botId, reference, error: String(error) },
    "computer provider unexpected error",
  );
  return new HttpError(502, "COMPUTER_PROVIDER_ERROR", `Le fournisseur Computer est inaccessible. Référence : ${reference}`);
}

function logProviderFailure(action: string, botId: string, error: ComputerProviderError): void {
  logger.warn({ event: "api.computer_provider_error", action, botId, code: error.code, status: error.status }, "computer provider error");
}
