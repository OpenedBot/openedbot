import { Hono } from "hono";
import type { AlertChannelListDto, AlertChannelTestDto } from "@openedbot/contracts-api";
import { isUuid } from "@openedbot/contracts-primitives";
import type { Db } from "@openedbot/platform-db";
import {
  createDiscordAlertChannel,
  deleteOrganizationAlertChannel,
  listOrganizationAlertChannels,
  testOrganizationAlertChannel,
  updateOrganizationAlertChannel,
} from "@openedbot/notifications/application/alert-channels";
import { createDiscordTransport, type DiscordTransport } from "@openedbot/notifications/application/discord-transport";
import { MAX_ALERT_CHANNELS_PER_ORGANIZATION, type AlertFailureReason } from "@openedbot/notifications/domain/alert-channels";
import { requireRole, type AppVariables } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";

/** Une URL de webhook et un libellé : rien de plus gros n'en est un. */
const MAX_BODY_BYTES = 2_048;

const FAILURE_MESSAGES: Record<AlertFailureReason, string> = {
  webhook_revoked: "Ce webhook n'existe plus côté Discord. Créez-en un nouveau dans le salon, puis ajoutez-le ici.",
  rejected: "Discord a refusé le message.",
  rate_limited: "Discord limite les envois de ce webhook pour le moment. Réessayez dans un instant.",
  unreachable: "Discord ne répond pas. Réessayez dans un instant.",
  decryption_failed: "Le webhook enregistré ne se déchiffre plus avec la clé du serveur. Supprimez ce canal et ajoutez-le de nouveau.",
};

/**
 * Canaux d'alerte de l'organisation (DEV-OPE2-7), sous `/api/alert-channels`.
 * Owner et admin seulement : un canal reçoit les pannes de tous les runtimes
 * de l'espace. L'URL du webhook entre ici et n'en ressort jamais.
 */
export function alertChannelRoutes(
  db: Db,
  config: Pick<ApiConfig, "tokenEncryption" | "deployEnvironment">,
  transport: DiscordTransport = createDiscordTransport(),
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const deps = { keyring: config.tokenEncryption, transport };

  routes.use("*", async (context, next) => {
    requireRole(context.get("auth"), ["owner", "admin"], "Seuls les owners et admins gèrent les alertes de l'espace.");
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const dto: AlertChannelListDto = {
      channels: await listOrganizationAlertChannels(db, auth.organizationId),
      limit: MAX_ALERT_CHANNELS_PER_ORGANIZATION,
    };
    return context.json(dto);
  });

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    const body = await readObject(context.req.raw);
    if (body.kind !== "discord") {
      throw new HttpError(400, "ALERT_CHANNEL_KIND_INVALID", "Seul Discord est disponible pour l'instant.");
    }
    const result = await createDiscordAlertChannel(
      db,
      { organizationId: auth.organizationId, userId: auth.userId },
      { webhookUrl: body.webhookUrl, label: body.label },
      deps,
    );
    switch (result.kind) {
      case "created":
        return context.json(result.channel, 201);
      case "invalid_url":
        throw new HttpError(400, "ALERT_CHANNEL_URL_INVALID", result.refusal === "not_discord"
          ? "Collez l'URL d'un webhook Discord (https://discord.com/api/webhooks/…)."
          : "Cette URL n'est pas celle d'un webhook Discord. Copiez-la depuis Paramètres du salon › Intégrations › Webhooks.");
      case "invalid_label":
        throw new HttpError(400, "ALERT_CHANNEL_LABEL_INVALID", "Le nom du canal fait entre 1 et 80 caractères.");
      case "webhook_not_found":
        throw new HttpError(422, "ALERT_CHANNEL_WEBHOOK_NOT_FOUND", "Discord ne connaît pas ce webhook. Vérifiez l'URL copiée, ou recréez le webhook.");
      case "discord_unreachable":
        throw new HttpError(502, "ALERT_CHANNEL_DISCORD_UNREACHABLE", FAILURE_MESSAGES.unreachable);
      case "duplicate":
        throw new HttpError(409, "ALERT_CHANNEL_DUPLICATE", "Ce webhook est déjà un canal d'alerte de l'espace.");
      case "limit_reached":
        throw new HttpError(409, "ALERT_CHANNEL_LIMIT", `Un espace a au plus ${result.limit} canaux d'alerte.`);
    }
  });

  routes.patch("/:id", async (context) => {
    const auth = context.get("auth");
    const id = readId(context.req.param("id"));
    const body = await readObject(context.req.raw);
    const result = await updateOrganizationAlertChannel(db, auth.organizationId, id, {
      enabled: body.enabled,
      label: body.label,
    });
    if (result.kind === "invalid") {
      throw new HttpError(400, "ALERT_CHANNEL_UPDATE_INVALID", "Envoyez `enabled` (booléen) ou `label` (1 à 80 caractères).");
    }
    if (result.kind === "not_found") throw notFound();
    return context.json(result.channel);
  });

  routes.delete("/:id", async (context) => {
    const auth = context.get("auth");
    const id = readId(context.req.param("id"));
    if (!(await deleteOrganizationAlertChannel(db, auth.organizationId, id))) throw notFound();
    return context.body(null, 204);
  });

  routes.post("/:id/test", async (context) => {
    const auth = context.get("auth");
    const id = readId(context.req.param("id"));
    const result = await testOrganizationAlertChannel(db, auth.organizationId, id, {
      ...deps,
      environment: config.deployEnvironment,
    });
    switch (result.kind) {
      case "delivered": {
        const dto: AlertChannelTestDto = { delivered: true, channel: result.channel };
        return context.json(dto);
      }
      case "failed":
        throw new HttpError(
          result.reason === "unreachable" || result.reason === "rate_limited" ? 502 : 422,
          "ALERT_CHANNEL_TEST_FAILED",
          FAILURE_MESSAGES[result.reason],
          {},
          { reason: result.reason, httpStatus: result.httpStatus, channel: result.channel },
        );
      case "cooldown":
        throw new HttpError(429, "ALERT_CHANNEL_TEST_COOLDOWN", `Un test toutes les ${result.seconds} secondes au plus.`, {
          "Retry-After": String(result.seconds),
        });
      case "not_found":
        throw notFound();
    }
  });

  return routes;
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const body = await jsonBody(request, MAX_BODY_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_JSON", "Le corps doit être un objet JSON.");
  }
  return body as Record<string, unknown>;
}

function readId(value: string | undefined): string {
  if (!value || !isUuid(value)) throw new HttpError(400, "ALERT_CHANNEL_ID_INVALID", "Identifiant de canal invalide.");
  return value;
}

function notFound(): HttpError {
  return new HttpError(404, "ALERT_CHANNEL_NOT_FOUND", "Ce canal d'alerte n'existe pas (ou plus).");
}
