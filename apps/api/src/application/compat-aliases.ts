/**
 * Path aliases declared by the loaded plug-ins (`CompatAliases.paths`): a
 * request under an old path gets a 308 to the new one (rest and query kept;
 * an `exact` alias redirects its one path and nothing below), before any
 * session check, and never over a route the core serves. In solo there is
 * none and an old path is simply unknown.
 */
import type { MiddlewareHandler } from "hono";
import type { CompatAlias } from "@openedbot/platform-plugins";

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
