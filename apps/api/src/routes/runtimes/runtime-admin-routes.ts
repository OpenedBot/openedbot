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
import { invalidateProvenRuntimeModels } from "@openedbot/runtimes/sql/model-selection-proofs";

/**
 * Dépôt d'un credential fournisseur (clé API, session OAuth) sur un runtime.
 *
 * OHB-15 reste vrai : l'API n'ouvre aucune session shell vers la machine d'un
 * client et ne détient aucune clé qui en ouvrirait une. Le runtime connector
 * offre l'opérateur edge-setup
 *     (`provider_management`, annoncé dans `hello` par le lien ou relu sur
 *     `GET /hermes-setup/capabilities` en direct) ; le credential est relayé
 *     vers cet opérateur : par le lien, ou en HTTPS via Caddy avec le bearer
 *     du gateway : et c'est lui qui exécute `hermes auth add`
 *     (docs/CONNECTOR.md, « Fournisseurs par le lien »). Seuls ces quatre
 *     verbes fournisseur transitent : aucune commande, aucun chemin, aucun
 *     autre verbe.
 *
 * Sans lien capable, la réponse honnête est 404 et le geste manuel sur l'hôte :
 * `edge-setup credentials add <fournisseur>`.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export function runtimeAdminRoutes(db: Db, config: ApiConfig, dependencies: { snapshotStore?: SnapshotStore } = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);
  /** Le canal d'écriture de CE runtime, croisé avec le mode de l'organisation. */
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
    const label = `ohb-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const management = await managementOf(auth.organizationId, row);

    if (management.kind === "host") {
      // La clé part dans le lien, vers l'opérateur de l'hôte ; le verdict est
      // celui que l'hôte a relu sur son propre catalogue. Un 409
      // CREDENTIAL_IN_PROGRESS (un seul `hermes auth add` à la fois) remonte
      // tel quel, sans absorption : contrairement à l'OAuth, il n'y a pas de
      // session à joindre.
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
      // La session vit sur l'hôte ; une session déjà ouverte est rendue
      // telle quelle (409 OAUTH_IN_PROGRESS absorbé par le client).
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
 * Une opération fournisseur relayée par le lien, et sa panne traduite.
 *
 * `not_sent` (lien fermé sur cette instance, opérateur de l'hôte muet, route
 * refusée par un edge-setup trop ancien) : rien n'a atteint l'hôte, 503.
 * Un refus de l'hôte (400/404/409) garde son statut et son code : c'est sa
 * réponse, pas la nôtre. Tout le reste est une écriture dont on ne sait pas
 * ce qu'elle a fait : 502. Aucun message ne porte la clé.
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

/** Identifiant de session OAuth tel que le contrat le borne : `[A-Za-z0-9._~-]{1,128}`. */
/**
 * Une reconnexion prouvée par l'hôte lève l'incident du fournisseur. La
 * lecture du catalogue ne le fait plus pour un `auth` : un credential révoqué
 * y reste `authenticated`.
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
