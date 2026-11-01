import { isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { normalizeLocale } from "@openedbot/contracts-locale";
import type {
  CreatePushSubscriptionInput,
  PushSubscriptionDto,
  PushSubscriptionListDto,
  PushVapidPublicKeyDto,
} from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";

const MAX_SUBSCRIPTIONS_PER_USER = 10;
const ENDPOINT_MAX = 2_048;
const KEY_MAX = 256;
const AUTH_MAX = 128;
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;

type SubscriptionRow = {
  id: string;
  endpoint: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
};

export function pushSubscriptionRoutes(
  db: Db,
  config: Pick<ApiConfig, "vapid">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/vapid-public-key", (context) => {
    if (!config.vapid) {
      throw new HttpError(404, "PUSH_NOT_CONFIGURED", "Le Web Push n’est pas configuré sur ce déploiement.");
    }
    const dto: PushVapidPublicKeyDto = { publicKey: config.vapid.publicKey, configured: true };
    context.header("Cache-Control", "no-store");
    return context.json(dto);
  });

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const rows = await withOwner(db, auth.organizationId, auth.userId, (tx) => tx<SubscriptionRow[]>`
      select id, endpoint, created_at as "createdAt", last_used_at as "lastUsedAt"
        from push_subscriptions
       where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
         and failed_at is null
       order by created_at desc
    `);
    const dto: PushSubscriptionListDto = {
      subscriptions: rows.map(subscriptionDto),
      configured: config.vapid !== null,
    };
    context.header("Cache-Control", "no-store");
    return context.json(dto);
  });

  routes.post("/", async (context) => {
    if (!config.vapid) {
      throw new HttpError(404, "PUSH_NOT_CONFIGURED", "Le Web Push n’est pas configuré sur ce déploiement.");
    }
    const auth = context.get("auth");
    const input = readSubscriptionInput(await jsonBody(context.req.raw));
    const userAgent = context.req.header("user-agent")?.trim().slice(0, 512) || null;
    const outcome = await withOwner(db, auth.organizationId, auth.userId, async (tx) => {
      const existing = await tx<SubscriptionRow[]>`
        select id, endpoint, created_at as "createdAt", last_used_at as "lastUsedAt"
          from push_subscriptions
         where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
           and endpoint = ${input.endpoint}
      `;
      if (existing[0]) {
        const updated = await tx<SubscriptionRow[]>`
          update push_subscriptions
             set p256dh = ${input.keys.p256dh}, auth = ${input.keys.auth},
                 user_agent = ${userAgent}, locale = ${input.locale},
                 failed_at = null, last_used_at = now()
           where id = ${existing[0].id} and user_id = ${auth.userId}
          returning id, endpoint, created_at as "createdAt", last_used_at as "lastUsedAt"
        `;
        return { created: false, row: updated[0] ?? existing[0] };
      }
      const count = await tx<Array<{ count: number }>>`
        select count(*)::int as count from push_subscriptions
         where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
           and failed_at is null
      `;
      if ((count[0]?.count ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
        throw new HttpError(409, "PUSH_SUBSCRIPTION_LIMIT", "Trop d’abonnements push pour ce compte.");
      }
      const inserted = await tx<SubscriptionRow[]>`
        insert into push_subscriptions (
          organization_id, user_id, endpoint, p256dh, auth, user_agent, locale
        ) values (
          ${auth.organizationId}, ${auth.userId}, ${input.endpoint},
          ${input.keys.p256dh}, ${input.keys.auth}, ${userAgent}, ${input.locale}
        )
        returning id, endpoint, created_at as "createdAt", last_used_at as "lastUsedAt"
      `;
      const created = inserted[0];
      if (!created) throw new HttpError(500, "INTERNAL_ERROR", "L’abonnement push n’a pas pu être enregistré.");
      return { created: true, row: created };
    });
    return context.json(subscriptionDto(outcome.row), outcome.created ? 201 : 200);
  });

  routes.delete("/", async (context) => {
    const auth = context.get("auth");
    const body = await jsonBody(context.req.raw);
    const endpoint = readEndpoint(body.endpoint);
    const deleted = await withOwner(db, auth.organizationId, auth.userId, (tx) => tx<Array<{ id: string }>>`
      delete from push_subscriptions
       where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
         and endpoint = ${endpoint}
      returning id
    `);
    if (!deleted[0]) throw new HttpError(404, "PUSH_SUBSCRIPTION_NOT_FOUND", "Cet abonnement push n’existe pas.");
    return context.body(null, 204);
  });

  return routes;
}

async function withOwner<T>(
  db: Db,
  organizationId: string,
  userId: string,
  callback: (tx: TransactionDb) => Promise<T>,
): Promise<T> {
  return withTenant(db, organizationId, async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
    return callback(tx);
  });
}

function readSubscriptionInput(body: Record<string, unknown>): CreatePushSubscriptionInput & { locale: "fr" | "en" } {
  const keysRaw = body.keys;
  if (!keysRaw || typeof keysRaw !== "object" || Array.isArray(keysRaw)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Les clés Push sont requises.");
  }
  const keys = keysRaw as Record<string, unknown>;
  return {
    endpoint: readEndpoint(body.endpoint),
    keys: {
      p256dh: readKey(keys.p256dh, "p256dh", 16, KEY_MAX),
      auth: readKey(keys.auth, "auth", 8, AUTH_MAX),
    },
    locale: normalizeLocale(body.locale),
  };
}

function readEndpoint(value: unknown): string {
  const endpoint = assertString(value, "L’endpoint Push", { max: ENDPOINT_MAX });
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error();
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "L’endpoint Push doit être une URL https.");
  }
  return endpoint;
}

function readKey(value: unknown, name: string, min: number, max: number): string {
  const key = assertString(value, `La clé ${name}`, { min, max });
  if (!URL_SAFE_BASE64.test(key)) {
    throw new HttpError(400, "VALIDATION_ERROR", `La clé ${name} est invalide.`);
  }
  return key;
}

function subscriptionDto(row: SubscriptionRow): PushSubscriptionDto {
  return {
    id: row.id,
    endpoint: row.endpoint,
    createdAt: isoInstant(row.createdAt),
    lastUsedAt: row.lastUsedAt ? isoInstant(row.lastUsedAt) : null,
  };
}
