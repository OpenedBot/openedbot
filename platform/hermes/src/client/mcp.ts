import {
  PROVIDER_MUTATION_TIMEOUT_MS,
  PROVIDER_POLL_TIMEOUT_MS,
  MCP_READ_TIMEOUT_MS,
  MCP_MUTATION_TIMEOUT_MS,
  MCP_INSTALL_TIMEOUT_MS,
  MCP_OAUTH_START_TIMEOUT_MS,
  type HermesMcpServer,
  type HermesMcpInventory,
  type HermesMcpOauthSession,
  type HermesGatewayRestartJob,
  type HermesGatewayStatus,
  type HermesMcpServerRequest,
} from "../contracts";
import {
  parseGatewayRestartJob as parseGatewayRestartJobResponse,
  parseGatewayStatus as parseGatewayStatusResponse,
  parseMcpInventory as parseMcpInventoryResponse,
  parseMcpOauthSession as parseMcpOauthSessionResponse,
  parseMcpServer as parseMcpServerResponse,
  providerErrorFromBody as providerError,
} from "../parsers";
import { record } from "../parsers/shared";
import type { HermesClientContext } from "./context";

function mcpServerRoutePath(server: string): string {
  return "/hermes-setup/mcp/servers/" + encodeURIComponent(server);
}

/** Serveurs MCP configurés sur l'hôte, plus le catalogue approuvé qu'il porte. */
export async function mcpInventory(ctx: HermesClientContext): Promise<HermesMcpInventory> {
  const response = await ctx.hostRequest("/hermes-setup/mcp/servers", { method: "GET" }, "safe", MCP_READ_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpInventoryResponse(await ctx.providerJson(response));
}

/**
 * Ajoute un serveur MCP HTTP. Le jeton porteur voyage dans le corps JSON
 * jusqu'à l'hôte, puis au stdin du programme : il n'apparaît ni dans le
 * chemin, ni dans un journal, ni dans la réponse.
 */
export async function mcpServerAdd(ctx: HermesClientContext, request: HermesMcpServerRequest): Promise<HermesMcpServer> {
  const response = await ctx.hostRequest(
    "/hermes-setup/mcp/servers",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    "mutation",
    MCP_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpServerResponse(await ctx.providerJson(response));
}

/**
 * Installe une entrée du catalogue approuvé de l'hôte. `env` ne porte que
 * les variables que l'entrée DÉCLARE : l'hôte refuse toute autre clé.
 */
export async function mcpCatalogInstall(ctx: HermesClientContext, name: string, env: Record<string, string> = {}): Promise<HermesMcpServer> {
  const response = await ctx.hostRequest(
    `/hermes-setup/mcp/catalog/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.keys(env).length ? { name, env } : { name }),
    },
    "mutation",
    MCP_INSTALL_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpServerResponse(await ctx.providerJson(response));
}

/**
 * Ouvre l'autorisation OAuth d'un serveur MCP sur l'hôte, avec l'URL de
 * retour d'openedbot que le fournisseur doit connaître. La session rendue porte
 * l'URL à ouvrir dès que l'hôte l'a obtenue. Un 409 `MCP_OAUTH_IN_PROGRESS`
 * n'est pas une erreur : l'hôte y joint la session déjà ouverte.
 */
/**
 * Ouvre l'autorisation OAuth d'un serveur MCP. Sans `profile`, pour la racine
 * du runtime ; avec, pour ce profil nommé (feature `mcp_oauth_profile`) : le
 * jeton va dans le home du profil, le seul que ses runs lisent. Un hôte plus
 * ancien ignorerait le champ et autoriserait la racine : l'appelant vérifie
 * la feature avant de l'envoyer.
 */
export async function mcpOauthStart(
  ctx: HermesClientContext,
  server: string,
  redirectUri: string,
  profile?: string,
): Promise<HermesMcpOauthSession> {
  const response = await ctx.hostRequest(
    `${mcpServerRoutePath(server)}/oauth`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile ? { redirectUri, profile } : { redirectUri }),
    },
    "mutation",
    MCP_OAUTH_START_TIMEOUT_MS,
  );
  if (response.status === 409) {
    const body = await ctx.providerJson(response);
    const conflict = record(body);
    const error = record(conflict?.error);
    if (error?.code === "MCP_OAUTH_IN_PROGRESS" && conflict?.session !== undefined) {
      return parseMcpOauthSessionResponse(conflict.session);
    }
    throw providerError(body, response.status);
  }
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpOauthSessionResponse(await ctx.providerJson(response));
}

/** Relit une autorisation MCP ; 404 `OAUTH_SESSION_NOT_FOUND` quand elle a expiré. */
export async function mcpOauthPoll(ctx: HermesClientContext, server: string, sessionId: string): Promise<HermesMcpOauthSession> {
  const response = await ctx.hostRequest(
    `${mcpServerRoutePath(server)}/oauth/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    "safe",
    PROVIDER_POLL_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpOauthSessionResponse(await ctx.providerJson(response));
}

/**
 * Relaie à l'hôte ce que le fournisseur a renvoyé au navigateur. La route
 * nomme le serveur, pas la session : l'URL de retour est enregistrée avant
 * qu'une session existe. `state` est validé sur l'hôte, et `iss` (RFC 9207)
 * aussi quand le fournisseur l'annonce : le SDK MCP refuse alors un retour
 * qui ne le porte pas (Linear, mesuré le 31-10).
 */
export async function mcpOauthCallback(
  ctx: HermesClientContext,
  server: string,
  callback: { code: string; state: string; iss?: string } | { error: string },
): Promise<HermesMcpOauthSession> {
  const response = await ctx.hostRequest(
    `${mcpServerRoutePath(server)}/oauth/callback`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(callback) },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseMcpOauthSessionResponse(await ctx.providerJson(response));
}

/** Annule une autorisation MCP sur l'hôte : 204, ou 404 si elle n'existe plus. */
export async function mcpOauthCancel(ctx: HermesClientContext, server: string, sessionId: string): Promise<void> {
  const response = await ctx.hostRequest(
    `${mcpServerRoutePath(server)}/oauth/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * L'état du gateway vu de l'hôte : un redémarrage est-il en attente. Le
 * gateway ne lit ses serveurs MCP qu'au démarrage ; sans cette lecture,
 * un serveur « porté par la plateforme » pourrait ne rien porter.
 */
export async function gatewayStatus(ctx: HermesClientContext): Promise<HermesGatewayStatus> {
  const response = await ctx.hostRequest("/hermes-setup/gateway", { method: "GET" }, "safe", PROVIDER_POLL_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseGatewayStatusResponse(await ctx.providerJson(response));
}

/**
 * Le SEUL redémarrage que le lien porte : route fixe, unité fixe sur
 * l'hôte, aucun argument. Rendu comme un job à suivre jusqu'à sa preuve sur
 * `/health`. Un 409 `GATEWAY_RESTART_IN_PROGRESS` rend le job en cours.
 */
export async function gatewayRestart(ctx: HermesClientContext): Promise<HermesGatewayRestartJob> {
  const response = await ctx.hostRequest(
    "/hermes-setup/gateway/restart",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    "mutation",
    PROVIDER_MUTATION_TIMEOUT_MS,
  );
  if (response.status === 409) {
    const body = await ctx.providerJson(response);
    const conflict = record(body);
    const error = record(conflict?.error);
    if (error?.code === "GATEWAY_RESTART_IN_PROGRESS" && conflict?.job !== undefined) {
      return parseGatewayRestartJobResponse(conflict.job);
    }
    throw providerError(body, response.status);
  }
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseGatewayRestartJobResponse(await ctx.providerJson(response));
}

/** Relit un redémarrage ; 404 `GATEWAY_RESTART_NOT_FOUND` quand il a expiré. */
export async function gatewayRestartPoll(ctx: HermesClientContext, jobId: string): Promise<HermesGatewayRestartJob> {
  const response = await ctx.hostRequest(
    `/hermes-setup/gateway/restart/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    "safe",
    PROVIDER_POLL_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseGatewayRestartJobResponse(await ctx.providerJson(response));
}

/** Retire un serveur MCP de l'hôte : 204, ou 404 s'il n'y était plus. */
export async function mcpServerRemove(ctx: HermesClientContext, name: string): Promise<void> {
  const response = await ctx.hostRequest(
    `/hermes-setup/mcp/servers/${encodeURIComponent(name)}`,
    { method: "DELETE" },
    "mutation",
    MCP_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  await response.body?.cancel().catch(() => undefined);
}
