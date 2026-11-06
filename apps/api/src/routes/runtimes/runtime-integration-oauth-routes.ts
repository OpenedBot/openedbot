import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { HermesClient, type HermesClientConfig, type HermesMcpOauthSession } from "@openedbot/hermes";
import type { RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requestOrigin, requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { connectorOpenedbotOrigin } from "./runtime-enrollment-routes";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import {
  type InventoryClient,
  MAX_OAUTH_CALLBACK,
  MCP_NAME_PATTERN,
  type RuntimeReader,
  SESSION_ID_PATTERN,
} from "./runtime-integration-constants";
import { publicMcpOauth, publicWriteError } from "./runtime-integration-public";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import {
  invalidateSnapshots,
  postgresSnapshotStore,
  type SnapshotStore,
} from "@openedbot/runtimes/application/runtime-read-snapshots";
import { RELAY_FEATURE_MCP_OAUTH } from "@openedbot/contracts-connector/features";

/** L’autorisation OAuth d’un serveur MCP : démarrage, suivi et annulation. */
export function runtimeMcpOauthRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const { config, invalidateIntegrationReads, requireWritableRuntime, requireWritableRuntimeWithId } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * L'autorisation OAuth d'un serveur MCP.
   *
   * Un serveur `auth: oauth` installé est inerte tant qu'un navigateur ne l'a
   * pas autorisé : et l'hôte n'en a pas. Ce navigateur-ci est la jambe humaine
   * du flux : l'API demande à l'hôte d'ouvrir l'autorisation en lui donnant
   * SON URL de retour, l'écran ouvre l'URL du fournisseur, et le fournisseur
   * renvoie le navigateur vers `GET /api/mcp-oauth/callback/…`, qui relaie
   * `code` + `state` à l'hôte. Rien de secret ne transite par l'écran : le
   * vérificateur PKCE et le jeton restent sur l'hôte.
   */
  routes.post("/integrations/mcp/servers/:name/oauth", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    if (!MCP_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "NAME_INVALID", "Ce nom de serveur n’est pas valide.");
    }
    const { client, runtimeId } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_MCP_OAUTH);
    const origin = connectorOpenedbotOrigin(config, requestOrigin(context) ?? undefined);
    const redirectUri = `${origin}/api/mcp-oauth/callback/${encodeURIComponent(auth.organizationId)}/${encodeURIComponent(runtimeId)}/${encodeURIComponent(name)}`;
    let session: HermesMcpOauthSession;
    try {
      session = await client.mcpOauthStart(name, redirectUri);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeMcpOauthDto>(publicMcpOauth(session));
  });

  routes.get("/integrations/mcp/servers/:name/oauth/:session", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    const sessionId = context.req.param("session");
    if (!MCP_NAME_PATTERN.test(name) || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(404, "OAUTH_SESSION_NOT_FOUND", "Cette autorisation n’existe plus.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_OAUTH);
    try {
      return context.json<RuntimeMcpOauthDto>(publicMcpOauth(await client.mcpOauthPoll(name, sessionId)));
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
  });

  routes.delete("/integrations/mcp/servers/:name/oauth/:session", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    const sessionId = context.req.param("session");
    if (!MCP_NAME_PATTERN.test(name) || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(404, "OAUTH_SESSION_NOT_FOUND", "Cette autorisation n’existe plus.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_OAUTH);
    try {
      await client.mcpOauthCancel(name, sessionId);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.body(null, 204);
  });

  return routes;
}

/**
 * Le retour OAuth d'un serveur MCP, hors authentification.
 *
 * Le fournisseur renvoie le navigateur ici, en navigation de premier niveau :
 * la session openedbot n'est pas garantie, et la route est donc publique. Son seul
 * pouvoir est de relayer `code` + `state` à l'hôte du runtime nommé, qui
 * valide `state` contre celui qu'il a généré (`compare_digest`) et refuse tout
 * le reste. Un `code` sans le vérificateur PKCE : qui ne quitte jamais l'hôte
 * : ne vaut rien ; un `state` deviné fait échouer l'autorisation, fermée.
 *
 * La page rendue ne porte ni le code, ni le state, ni un texte amont : elle
 * dit « revenez à openedbot », ou la cause du refus par son code.
 */
export function mcpOauthCallbackRoutes(
  db: Db,
  config: ApiConfig,
  dependencies: {
    readRuntime?: RuntimeReader;
    clientFactory?: (config: HermesClientConfig) => Pick<InventoryClient, "mcpOauthCallback">;
    snapshotStore?: SnapshotStore;
  } = {},
): Hono {
  const routes = new Hono();
  const readRuntime = dependencies.readRuntime ?? readRuntimeSecret;
  const clientFactory = dependencies.clientFactory ?? ((clientConfig) => new HermesClient(clientConfig));
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);

  routes.get("/callback/:organizationId/:runtimeId/:name", async (context) => {
    const organizationId = context.req.param("organizationId");
    const runtimeId = context.req.param("runtimeId");
    const name = context.req.param("name");
    const code = context.req.query("code") ?? "";
    const state = context.req.query("state") ?? "";
    const providerError = context.req.query("error") ?? "";
    // RFC 9207: the issuer the provider names in its redirect. Relayed as is;
    // the host checks it against the server's metadata.
    const issuer = context.req.query("iss") ?? "";
    if (!isUuid(organizationId) || !isUuid(runtimeId) || !MCP_NAME_PATTERN.test(name)) {
      return context.html(oauthCallbackPage(false, "CALLBACK_INVALID"), 404);
    }
    if (
      code.length > MAX_OAUTH_CALLBACK || state.length > MAX_OAUTH_CALLBACK || providerError.length > 200
      || issuer.length > MAX_OAUTH_CALLBACK
      || (code === "" && providerError === "")
      || (code !== "" && state === "")
    ) {
      return context.html(oauthCallbackPage(false, "CALLBACK_INVALID"), 400);
    }
    const runtime = await readRuntime(db, config, organizationId).catch(() => null);
    if (!runtime || runtime.id !== runtimeId) {
      return context.html(oauthCallbackPage(false, "RUNTIME_UNKNOWN"), 404);
    }
    const client = clientFactory(runtime.client);
    let session: HermesMcpOauthSession;
    try {
      session = await client.mcpOauthCallback(
        name,
        providerError !== "" ? { error: providerError } : { code, state, ...(issuer !== "" ? { iss: issuer } : {}) },
      );
    } catch (error) {
      const failure = publicWriteError(error);
      return context.html(oauthCallbackPage(false, failure.code), failure.status as 400);
    } finally {
      await Promise.all([
        invalidateSnapshots(snapshots, organizationId, "mcp"),
        invalidateSnapshots(snapshots, organizationId, "integrations"),
      ]);
    }
    if (session.status === "failed" || session.status === "cancelled") {
      return context.html(oauthCallbackPage(false, session.errorCode ?? "OAUTH_FAILED"), 400);
    }
    return context.html(oauthCallbackPage(true));
  });
  return routes;
}

function oauthCallbackPage(ok: boolean, code?: string): string {
  const title = ok ? "Autorisation reçue" : "Autorisation refusée";
  const message = ok
    ? "L’hôte termine l’autorisation. Vous pouvez fermer cet onglet et revenir à openedbot."
    : `Cause : ${(code ?? "OAUTH_FAILED").replace(/[^A-Z0-9_]/gi, "")}. Revenez à openedbot pour recommencer.`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}
