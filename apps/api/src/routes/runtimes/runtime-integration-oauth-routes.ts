import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import {
  HermesClientError,
  HermesMcpOauthConflictError,
  type HermesClientConfig,
  type HermesMcpOauthSession,
} from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import type { RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requestOrigin, requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
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

/** OAuth authorization of an MCP server: start, follow-up and cancellation. */
export function runtimeMcpOauthRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const { config, invalidateIntegrationReads, requireWritableRuntime, requireWritableRuntimeWithId } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * OAuth authorization of an MCP server.
   *
   * An installed `auth: oauth` server is inert until a browser has
   * authorized it: and the host has none. This browser is the human leg
   * of the flow: the API asks the host to open the authorization by giving it
   * ITS return URL, the screen opens the provider's URL, and the provider
   * sends the browser back to `GET /api/mcp-oauth/callback/…`, which relays
   * `code` + `state` to the host. Nothing secret passes through the screen: the
   * PKCE verifier and the token stay on the host.
   */
  routes.post("/integrations/mcp/servers/:name/oauth", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    if (!MCP_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "NAME_INVALID", "Ce nom de serveur n’est pas valide.");
    }
    const body = await jsonBody(context.req.raw);
    const { client, runtimeId } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_MCP_OAUTH);
    const origin = connectorOpenedbotOrigin(config, requestOrigin(context) ?? undefined);
    const redirectUri = `${origin}/api/mcp-oauth/callback/${encodeURIComponent(auth.organizationId)}/${encodeURIComponent(runtimeId)}/${encodeURIComponent(name)}`;
    let session: HermesMcpOauthSession;
    try {
      session = await startMcpOauth(client, { server: name, redirectUri, replacePending: body.replacePending === true });
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
 * Opens an authorization on the host, for the runtime root or for ONE
 * profile.
 *
 * The host keeps one authorization per server. When another one is in
 * progress (another bot's, or one an older host does not attribute), the
 * client refuses it as `MCP_OAUTH_IN_PROGRESS` rather than return it as this
 * request's: its token would land in someone else's profile. The operator
 * then decides; `replacePending` is that decision: the pending one is
 * cancelled, and this one starts. A host that already received the
 * provider's callback for it refuses the cancel (`OAUTH_CALLBACK_RECEIVED`):
 * that authorization has just been approved and is completing, so it is
 * reported as a conflict, never undone.
 */
export async function startMcpOauth(
  client: Pick<InventoryClient, "mcpOauthStart" | "mcpOauthCancel">,
  request: { server: string; redirectUri: string; profile?: string; replacePending: boolean },
): Promise<HermesMcpOauthSession> {
  const { server, redirectUri, profile } = request;
  try {
    return await client.mcpOauthStart(server, redirectUri, profile);
  } catch (error) {
    if (!request.replacePending || !(error instanceof HermesMcpOauthConflictError)) throw error;
    try {
      await client.mcpOauthCancel(server, error.pendingSessionId);
    } catch (cancelError) {
      if (cancelError instanceof HermesClientError && cancelError.code === "OAUTH_CALLBACK_RECEIVED") {
        throw new HttpError(
          409,
          "OAUTH_CALLBACK_RECEIVED",
          "L’autre autorisation vient d’être approuvée chez le fournisseur et se termine sur l’hôte. Réessayez dans un instant.",
        );
      }
      // It ended in the meantime: there is nothing left to cancel.
      if (!(cancelError instanceof HermesClientError && cancelError.code === "OAUTH_SESSION_NOT_FOUND")) throw cancelError;
    }
    return client.mcpOauthStart(server, redirectUri, profile);
  }
}

/**
 * An MCP server's OAuth return, outside authentication.
 *
 * The provider sends the browser here, in a top-level navigation:
 * the openedbot session is not guaranteed, and the route is therefore public. Its only
 * power is to relay `code` + `state` to the named runtime's host, which
 * validates `state` against the one it generated (`compare_digest`) and refuses
 * everything else. A `code` without the PKCE verifier : which never leaves the host
 * : is worth nothing; a guessed `state` fails the authorization, closed.
 *
 * The rendered page carries neither the code, nor the state, nor an upstream text: it
 * says « revenez à openedbot », or the cause of the refusal by its code.
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
  const clientFactory = dependencies.clientFactory ?? runtimeAdminClient;
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
      // The provider's refusal carries the `state` too: the host checks it,
      // so a forged `?error=` cannot fail someone's pending authorization.
      session = await client.mcpOauthCallback(
        name,
        providerError !== ""
          ? { error: providerError, ...(state !== "" ? { state } : {}) }
          : { code, state, ...(issuer !== "" ? { iss: issuer } : {}) },
      );
    } catch (error) {
      const failure = publicWriteError(error);
      return context.html(oauthCallbackPage(false, failure.code), failure.status as 400);
    } finally {
      await Promise.all([
        invalidateSnapshots(snapshots, organizationId, "mcp"),
        invalidateSnapshots(snapshots, organizationId, "integrations"),
        // A bot's connection is recorded in its profile's configuration.
        invalidateSnapshots(snapshots, organizationId, "profiles"),
      ]);
    }
    if (session.status === "failed" || session.status === "cancelled") {
      return context.html(oauthCallbackPage(false, session.errorCode ?? "OAUTH_FAILED"), 400);
    }
    // A refusal relayed to the host ends the authorization: never « reçue ».
    if (providerError !== "") return context.html(oauthCallbackPage(false, "OAUTH_DENIED"), 400);
    return context.html(oauthCallbackPage(true));
  });
  return routes;
}

function oauthCallbackPage(ok: boolean, code?: string): string {
  // A replayed return (a reloaded tab) proves nothing about the authorization
  // it belonged to: the page says so, and sends back to openedbot for the state.
  const used = !ok && code === "OAUTH_CALLBACK_USED";
  const title = ok ? "Autorisation reçue" : used ? "Retour déjà traité" : "Autorisation refusée";
  const message = ok
    ? "L’hôte termine l’autorisation. Vous pouvez fermer cet onglet et revenir à openedbot."
    : used
      ? "Ce retour d’autorisation a déjà été transmis à l’hôte. Revenez à openedbot pour voir où en est la connexion."
      : `Cause : ${(code ?? "OAUTH_FAILED").replace(/[^A-Z0-9_]/gi, "")}. Revenez à openedbot pour recommencer.`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}
