import { Hono } from "hono";
import { providerApiKey, providerSlug } from "@openedbot/runtimes/domain/runtime/provider-credentials";
import type {
  RuntimeProviderCredentialDto,
  RuntimeProviderOauthDto,
} from "@openedbot/contracts-api";
import { HermesClientError } from "@openedbot/hermes";
import type { ApiConfig } from "../../infrastructure/config";
import { withTenant, type Db } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { resolveRuntime } from "./runtime-model-routes";
import { invalidateSnapshots, postgresSnapshotStore, type SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { runtimeManagement, type RuntimeManagement, type RuntimeRow } from "./runtime-routes";
import { invalidateProvenRuntimeModels } from "@openedbot/runtimes/application/model-selection-proof";

/**
 * Deposit of a provider credential (API key, OAuth session) onto a runtime.
 *
 * Always true: the API opens no shell session toward a customer's
 * machine and holds no key that would open one. The connector runtime
 * offers the edge-setup operator
 *     (`provider_management`, advertised in `hello` by the link or reread on
 *     `GET /hermes-setup/capabilities` directly); the credential is relayed
 *     to that operator: over the link, or over HTTPS via Caddy with the
 *     gateway's bearer: and it is the one that runs `hermes auth add`
 *     (docs/CONNECTOR.md, « Fournisseurs par le lien »). Only those four
 *     provider verbs pass through: no command, no path, no
 *     other verb.
 *
 * Without a capable link, the honest answer is 404 and the manual gesture on the host:
 * `edge-setup credentials add <fournisseur>`.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export function runtimeAdminRoutes(db: Db, config: ApiConfig, dependencies: { snapshotStore?: SnapshotStore } = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);
  /** THIS runtime's write channel, crossed with the organization's mode. */
  const managementOf = async (_organizationId: string, row: RuntimeRow): Promise<RuntimeManagement> =>
    runtimeManagement(row, "disabled");

  routes.post("/:runtimeId/providers/:slug/credentials", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = context.req.param("runtimeId");
    const provider = providerSlug(context.req.param("slug"));
    const body = await jsonBody(context.req.raw);
    const apiKey = providerApiKey(body.apiKey);
    const { row, client } = await resolveRuntime(db, config, auth.organizationId, runtimeId);
    const label = `openedbot-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const management = await managementOf(auth.organizationId, row);

    if (management.kind === "host") {
      // The key leaves over the link, toward the host's operator; the verdict is
      // the one the host reread on its own catalog. A 409
      // CREDENTIAL_IN_PROGRESS (only one `hermes auth add` at a time) comes back
      // as-is, without absorption: unlike OAuth, there is no
      // session to join.
      let result: Awaited<ReturnType<typeof client.providerCredentialAdd>>;
      try {
        result = await linkOperation(() => client.providerCredentialAdd(provider, apiKey, label));
      } finally {
        await withTenant(db, auth.organizationId, (tx) => invalidateProvenRuntimeModels(tx, auth.organizationId, runtimeId, provider));
        await invalidateSnapshots(snapshots, auth.organizationId, "models");
      }
      if (result.verification === "confirmed") {
        await clearProviderIncidentAfterReauth(db, auth.organizationId, runtimeId, provider);
      }
      return context.json<RuntimeProviderCredentialDto>({
        runtimeId,
        provider,
        label: result.label,
        verification: result.verification,
        provesInference: result.verification === "confirmed" && provider !== "moa",
        detail: result.detail,
      });
    }

    throw new HttpError(404, "RUNTIME_ADMIN_DISABLED", "openedbot ne peut pas poser cet accès sur ce runtime. Posez la clé sur votre hôte avec `edge-setup credentials add <fournisseur>`.");
  });

  routes.post("/:runtimeId/providers/:slug/auth", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = context.req.param("runtimeId");
    const provider = providerSlug(context.req.param("slug"));
    const { row, client } = await resolveRuntime(db, config, auth.organizationId, runtimeId);
    const management = await managementOf(auth.organizationId, row);

    if (management.kind === "host") {
      // The session lives on the host; a session already open is returned
      // as-is (409 OAUTH_IN_PROGRESS absorbed by the client).
      const session = await linkOperation(() => client.providerOauthStart(provider));
      await invalidateSnapshots(snapshots, auth.organizationId, "models");
      if (session.status === "connected") {
        await withTenant(db, auth.organizationId, (tx) => invalidateProvenRuntimeModels(tx, auth.organizationId, runtimeId, provider));
        await clearProviderIncidentAfterReauth(db, auth.organizationId, runtimeId, provider);
      }
      return context.json<RuntimeProviderOauthDto>(session);
    }

    throw new HttpError(404, "RUNTIME_ADMIN_DISABLED", "openedbot ne peut pas autoriser ce fournisseur sur ce runtime. Utilisez edge-setup sur votre hôte.");
  });

  routes.get("/:runtimeId/providers/:slug/auth", async (context) => {
    const auth = context.get("auth");
    const runtimeId = context.req.param("runtimeId");
    const provider = providerSlug(context.req.param("slug"));
    const { row, client } = await resolveRuntime(db, config, auth.organizationId, runtimeId);
    const management = await managementOf(auth.organizationId, row);
    const id = context.req.query("sessionId");

    if (management.kind === "host") {
      const sessionId = oauthSessionId(id);
      const session = await linkOperation(() => client.providerOauthPoll(provider, sessionId));
      if (session.status === "connected") await invalidateSnapshots(snapshots, auth.organizationId, "models");
      if (session.status === "connected") {
        await withTenant(db, auth.organizationId, (tx) => invalidateProvenRuntimeModels(tx, auth.organizationId, runtimeId, provider));
        await clearProviderIncidentAfterReauth(db, auth.organizationId, runtimeId, provider);
      }
      return context.json<RuntimeProviderOauthDto>(session);
    }

    throw new HttpError(404, "RUNTIME_ADMIN_DISABLED", "openedbot ne peut pas lire cette autorisation sur ce runtime.");
  });

  routes.delete("/:runtimeId/providers/:slug/auth", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = context.req.param("runtimeId");
    const provider = providerSlug(context.req.param("slug"));
    const { row, client } = await resolveRuntime(db, config, auth.organizationId, runtimeId);
    const management = await managementOf(auth.organizationId, row);
    const id = context.req.query("sessionId");

    if (management.kind === "host") {
      const sessionId = oauthSessionId(id);
      await linkOperation(() => client.providerOauthCancel(provider, sessionId));
      await invalidateSnapshots(snapshots, auth.organizationId, "models");
      return context.body(null, 204);
    }

    throw new HttpError(404, "RUNTIME_ADMIN_DISABLED", "openedbot ne peut pas annuler cette autorisation sur ce runtime.");
  });

  return routes;
}

/**
 * A provider operation relayed by the link, and its failure translated.
 *
 * `not_sent` (link closed on this instance, host operator silent, route
 * refused by an edge-setup that is too old): nothing reached the host, 503.
 * A refusal from the host (400/404/409) keeps its status and its code: it is its
 * response, not ours. Everything else is a write whose effect is not known:
 * 502. No message carries the key.
 */
async function linkOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof HermesClientError) {
      if (error.code === "HERMES_LINK_PATH_FORBIDDEN") {
        throw new HttpError(
          503,
          "RUNTIME_LINK_UNAVAILABLE",
          "L’hôte n’accepte pas cette route par le lien : mettez edge-setup à jour.",
        );
      }
      if (error.requestDelivery === "not_sent" || error.code === "HERMES_OPERATOR_UNAVAILABLE") {
        throw new HttpError(503, "RUNTIME_LINK_UNAVAILABLE", "L’hôte n’est pas joignable par le lien.");
      }
      if (error.status === 400 || error.status === 404 || error.status === 409) {
        throw new HttpError(error.status, error.code, error.message);
      }
    }
    throw new HttpError(502, "RUNTIME_PROVIDER_WRITE_FAILED", "L’hôte n’a pas appliqué l’opération fournisseur.");
  }
}

/** OAuth session identifier as the contract bounds it: `[A-Za-z0-9._~-]{1,128}`. */
/**
 * A reconnection proven by the host clears the provider's incident. The
 * catalog read no longer does so for an `auth`: a revoked credential
 * stays `authenticated` there.
 */
async function clearProviderIncidentAfterReauth(
  db: Db,
  organizationId: string,
  runtimeId: string,
  provider: string,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    await tx`
      delete from runtime_provider_incidents
       where organization_id = ${organizationId} and runtime_id = ${runtimeId} and provider = ${provider}
    `;
  });
}

function oauthSessionId(value: string | undefined): string {
  if (!value) throw new HttpError(400, "RUNTIME_OAUTH_SESSION_REQUIRED", "La session d’autorisation est requise.");
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new HttpError(400, "RUNTIME_OAUTH_SESSION_INVALID", "Identifiant de session d’autorisation invalide.");
  }
  return value;
}
