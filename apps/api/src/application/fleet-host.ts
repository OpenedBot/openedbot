/**
 * What the API lends the plug-in that brings the fleet capability
 * (`fleet.workspaces`, open-core step 11.2) as `context.host.fleet`. The
 * routes live in the plug-in; what only the API app knows stays here and is
 * lent framework-free (a `Request` in, plain data out), so the plug-in need
 * not share the core's Hono copy:
 *
 * - `config`: the resolved API config;
 * - `enabled(viewer?)`: `fleet.workspaces` for that viewer, as the core
 *   session reads it;
 * - `session.optional(request)`: who is signed in, without requiring it;
 * - `session.authenticate(request)`: the core session middleware, for a
 *   public route that needs a session on one account action (accept or
 *   decline an invitation: a session without a workspace yet is accepted,
 *   as on `/api/invite/member/…`); throws the core's `HttpError` (401, 403)
 *   unchanged;
 * - `session.open(request, userId, clientIp)`: a new web session, returned
 *   as its CSRF token and the `Set-Cookie` lines to answer with.
 */
import { Hono, type Context } from "hono";
import type { Db } from "@openedbot/platform-db";
import { createWebSession } from "@openedbot/identity/application/sessions";
import type { ApiConfig } from "../infrastructure/config";
import type { EntitlementScope } from "@openedbot/identity/application/entitlements";
import { fleetWorkspacesEnabled, type ProductFeatureSource } from "./product-features";
import { authMiddleware, readOptionalSessionIdentity, writeWebSessionCookies, type AppVariables, type AuthContext, type OptionalSessionIdentity } from "../routes/identity/auth";

export type FleetSessionHost = {
  readonly optional: (request: Request) => Promise<OptionalSessionIdentity | null>;
  readonly authenticate: (request: Request) => Promise<AuthContext>;
  readonly open: (request: Request, userId: string, clientIp: string | null) => Promise<{ readonly csrf: string; readonly setCookie: readonly string[] }>;
};

export type FleetHost = {
  readonly config: ApiConfig;
  readonly enabled: (viewer?: EntitlementScope) => Promise<boolean>;
  readonly session: FleetSessionHost;
};

/** Runs `work` inside a throwaway Hono context for `request`; its throw is rethrown as is. */
async function inContext<T>(request: Request, work: (context: Context<{ Variables: AppVariables }>) => Promise<T>): Promise<{ value: T; response: Response }> {
  const app = new Hono<{ Variables: AppVariables }>();
  let value: T | undefined;
  let failure: { error: unknown } | null = null;
  app.all("*", async (context) => {
    try {
      value = await work(context);
    } catch (error) {
      failure = { error };
    }
    return context.body(null, 204);
  });
  const response = await app.fetch(request);
  if (failure) throw (failure as { error: unknown }).error;
  return { value: value as T, response };
}

/**
 * Who is signed in on `request`, without requiring it (the core's
 * `readOptionalSessionIdentity`, CSRF of unsafe methods included). Also lent
 * to the help desk provider (`context.host.staff.session.optional`).
 */
export function optionalSession(db: Db): FleetSessionHost["optional"] {
  return async (request: Request) => (await inContext(request, (context) => readOptionalSessionIdentity(db, context))).value;
}

export function fleetHost(db: Db, config: ApiConfig, entitlements: ProductFeatureSource): FleetHost {
  const middleware = authMiddleware(db, entitlements, { accountIdentity: true });
  return Object.freeze({
    config,
    enabled: (viewer?: EntitlementScope) => fleetWorkspacesEnabled(entitlements, viewer),
    session: Object.freeze({
      optional: optionalSession(db),
      authenticate: async (request: Request) => (await inContext(request, async (context) => {
        let auth: AuthContext | undefined;
        await middleware(context, async () => {
          auth = context.get("auth");
        });
        return auth!;
      })).value,
      open: async (request: Request, userId: string, clientIp: string | null) => {
        const { value, response } = await inContext(request, async (context) => {
          const userAgent = request.headers.get("user-agent")?.slice(0, 256) ?? null;
          const session = await createWebSession(db, null, userId, { userAgent, ip: clientIp });
          writeWebSessionCookies(context, config, session);
          return session.csrf;
        });
        return { csrf: value, setCookie: response.headers.getSetCookie() };
      },
    }),
  });
}
