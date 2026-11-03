import {
  PROVIDER_MUTATION_TIMEOUT_MS,
  PROVIDER_POLL_TIMEOUT_MS,
  type HermesProviderCredentialResult,
  type HermesProviderOauthSession,
  type HermesProviderUsageDocument,
  type HermesModelContext,
} from "../contracts";
import {
  parseProviderCredentialResult as parseCredentialResult,
  parseProviderOauthSession as parseOauthSession,
  parseModelContextDocument,
  parseProviderUsageDocument as parseUsageDocument,
  providerErrorFromBody as providerError,
} from "../parsers";
import { record } from "../parsers/shared";
import type { HermesClientContext } from "./context";

function providerRoutePath(provider: string): string {
  return "/hermes-setup/providers/" + encodeURIComponent(provider);
}

/**
 * Limites des comptes fournisseur, lues par l'opérateur de l'hôte. Cette
 * route est à la racine comme les autres routes `/hermes-setup/*` : elle ne
 * connaît ni profil Hermes ni clé fournisseur côté openedbot.
 */
export async function providerUsage(ctx: HermesClientContext, options: { refresh?: boolean } = {}): Promise<HermesProviderUsageDocument> {
  // `refresh` : l'opérateur hôte garde sa dernière lecture une minute ;
  // « Actualiser » demande une sonde neuve, sinon le bouton relit le cache.
  const response = await ctx.hostRequest(
    "/hermes-setup/usage",
    { method: "GET", headers: options.refresh ? { "cache-control": "no-cache" } : undefined },
    "safe",
    40_000,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseUsageDocument(await ctx.providerJson(response));
}

/**
 * La fenêtre de contexte que ce runtime applique réellement au modèle
 * configuré, lue par l'opérateur de l'hôte.
 *
 * Le gateway ne la publie nulle part : `/v1/models` ne rend qu'un
 * identifiant, `/api/model/options` l'inventaire du sélecteur, et
 * `/v1/capabilities` des drapeaux. L'amont la résout dans
 * `agent/model_metadata.py` et ne la sert que sur le Dashboard de son CLI,
 * que le lien ne porte pas. Un runtime sans opérateur `edge-setup` n'a
 * donc pas cette route : l'appelant retombe sur sa propre table.
 */
export async function modelContext(ctx: HermesClientContext, options: { profile?: string } = {}): Promise<HermesModelContext> {
  const query = options.profile ? `?profile=${encodeURIComponent(options.profile)}` : "";
  const response = await ctx.hostRequest(
    `/hermes-setup/model-context${query}`,
    { method: "GET" },
    "safe",
    40_000,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseModelContextDocument(await ctx.providerJson(response));
}

/**
 * Dépôt d'une clé API sur l'hôte, par la route HÔTE
 * `POST /hermes-setup/providers/{provider}/credentials` (docs/CONNECTOR.md,
 * « Fournisseurs par le lien »). La clé voyage dans le corps JSON jusqu'au
 * connecteur, puis au stdin de `hermes auth add` : elle n'apparaît ni dans
 * le chemin, ni dans un journal, ni dans une erreur. Le verdict rendu est
 * celui de l'hôte, relu sur son catalogue, jamais déduit ici. Un 409
 * `CREDENTIAL_IN_PROGRESS` reste une erreur : contrairement à l'OAuth par
 * code d'appareil, le contrat ne joint aucune session à absorber : l'hôte
 * n'exécute qu'un `hermes auth add` à la fois pour ce fournisseur.
 */
export async function providerCredentialAdd(ctx: HermesClientContext, provider: string, apiKey: string, label?: string): Promise<HermesProviderCredentialResult> {
  const response = await ctx.hostRequest(
    `${providerRoutePath(provider)}/credentials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(label === undefined ? { apiKey } : { apiKey, label }),
    },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseCredentialResult(await ctx.providerJson(response));
}

/**
 * Ouvre une session OAuth par code d'appareil sur l'hôte. Un 409
 * `OAUTH_IN_PROGRESS` n'est pas une erreur : l'hôte y joint la session déjà
 * ouverte (`starting`/`pending`) pour ce fournisseur, et c'est elle qu'on rend.
 */
export async function providerOauthStart(ctx: HermesClientContext, provider: string): Promise<HermesProviderOauthSession> {
  const response = await ctx.hostRequest(
    `${providerRoutePath(provider)}/oauth`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (response.status === 409) {
    const body = await ctx.providerJson(response);
    const conflict = record(body);
    const error = record(conflict?.error);
    if (error?.code === "OAUTH_IN_PROGRESS" && conflict?.session !== undefined) {
      return parseOauthSession(conflict.session);
    }
    throw providerError(body, response.status);
  }
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseOauthSession(await ctx.providerJson(response));
}

/** Relit une session OAuth de l'hôte ; 404 `OAUTH_SESSION_NOT_FOUND` quand elle a expiré. */
export async function providerOauthPoll(ctx: HermesClientContext, provider: string, sessionId: string): Promise<HermesProviderOauthSession> {
  const response = await ctx.hostRequest(
    `${providerRoutePath(provider)}/oauth/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    "safe",
    PROVIDER_POLL_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseOauthSession(await ctx.providerJson(response));
}

/** Annule une session OAuth sur l'hôte : 204, ou 404 si elle n'existe plus. */
export async function providerOauthCancel(ctx: HermesClientContext, provider: string, sessionId: string): Promise<void> {
  const response = await ctx.hostRequest(
    `${providerRoutePath(provider)}/oauth/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  await response.body?.cancel().catch(() => undefined);
}
