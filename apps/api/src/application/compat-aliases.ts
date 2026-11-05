/**
 * Compatibility aliases declared by the loaded plug-ins (`CompatAliases`,
 * open-core step 11.2). In solo every table is empty and an old name is
 * simply unknown.
 *
 * - headers and query parameters: `requestHeader` / `requestQuery` read the
 *   current name, then the old names a plug-in maps onto it;
 * - paths: `compatPathRedirects` answers 308 from an old path to the new
 *   one (rest and query kept; an `exact` alias redirects its one path and
 *   nothing below), before any session check, and never over a route the
 *   core serves;
 * - entitlements: handed to `createEntitlementSource` (`pro.aliases`).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { CompatAlias, CompatAliases } from "@openedbot/platform-plugins";

type Installed = { readonly headers: readonly CompatAlias[]; readonly queries: readonly CompatAlias[] };

const NONE: Installed = { headers: [], queries: [] };
let installed: Installed = NONE;

/** Installed once by the composition root; tests reset it with `installCompatAliases({})`. */
export function installCompatAliases(aliases: CompatAliases): void {
  installed = { headers: aliases.headers ?? [], queries: aliases.queries ?? [] };
}

/** The old header names the CORS preflight must also allow. */
export function compatHeaderNames(): string[] {
  return installed.headers.map((alias) => alias.from);
}

/** The header `name`, or the first old name a plug-in maps onto it. */
export function requestHeader(context: Context, name: string): string | undefined {
  const value = context.req.header(name);
  if (value) return value;
  const lower = name.toLowerCase();
  for (const alias of installed.headers) {
    if (alias.to.toLowerCase() !== lower) continue;
    const old = context.req.header(alias.from);
    if (old) return old;
  }
  return undefined;
}

/** The query parameter `name`, or the first old name a plug-in maps onto it. */
export function requestQuery(context: Context, name: string): string | undefined {
  const value = context.req.query(name);
  if (value) return value;
  for (const alias of installed.queries) {
    if (alias.to !== name) continue;
    const old = context.req.query(alias.from);
    if (old) return old;
  }
  return undefined;
}

type CoreRoute = { readonly method: string; readonly path: string };

/**
 * Does a core route answer some path under `from`? Then the alias would
 * shadow it. Middlewares and mounts (`ALL`) are not routes.
 */
export function shadowsCoreRoute(from: string, routes: readonly CoreRoute[]): boolean {
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  return routes.some((route) => {
    if (route.method === "ALL") return false;
    const segments = route.path.split("/");
    const dynamic = segments.findIndex((segment) => segment.startsWith(":") || segment.includes("*"));
    if (dynamic === -1) return under(route.path, from);
    const head = segments.slice(0, dynamic).join("/");
    return under(head, from) || under(from, head);
  });
}

/**
 * 308 redirects for the path aliases. `coreRoutes` is read on the first
 * request (every core route is registered by then); an alias that would
 * shadow one is dropped and reported through `warn`, once.
 */
export function compatPathRedirects(
  aliases: readonly CompatAlias[],
  coreRoutes: () => readonly CoreRoute[],
  warn: (event: { from: string; reason: string }) => void = () => undefined,
): MiddlewareHandler {
  let live: readonly CompatAlias[] | null = null;
  const resolve = () => {
    if (live) return live;
    const routes = coreRoutes();
    live = aliases.filter((alias) => {
      if (!shadowsCoreRoute(alias.from, routes)) return true;
      warn({ from: alias.from, reason: "shadows a core route" });
      return false;
    });
    return live;
  };
  return async (context, next) => {
    if (aliases.length === 0) return next();
    const path = context.req.path;
    const alias = resolve().find((entry) => path === entry.from || (!entry.exact && path.startsWith(`${entry.from}/`)));
    if (!alias) return next();
    const url = new URL(context.req.url);
    const location = `${alias.to}${path.slice(alias.from.length)}${url.search}`;
    context.header("Cache-Control", "no-store");
    return context.redirect(location, 308);
  };
}
