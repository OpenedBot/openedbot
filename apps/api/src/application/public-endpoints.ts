import { Hono } from "hono";
import type { ProPlugin } from "@openedbot/platform-plugins";
import { shadowsCoreRoute } from "./compat-aliases";

/** Keep declarations even when the DB role guard refuses their implementation. */
export function publicEndpointPaths(loaded: readonly ProPlugin[]): ReadonlySet<string> {
  return new Set(loaded.flatMap((plugin) => (plugin.publicEndpoints ?? []).map((endpoint) => endpoint.path)));
}

export function pluginPublicEndpoints<Context>(loaded: readonly ProPlugin[], installed: readonly ProPlugin[], contextFor: (plugin: ProPlugin) => Context): Hono {
  const app = new Hono();
  app.onError((error) => { throw error; });
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
  const keys = new Set<string>();
  for (const declaration of loaded) {
    const plugin = installed.find((candidate) => candidate.manifest.id === declaration.manifest.id);
    for (const endpoint of declaration.publicEndpoints ?? []) {
      const key = endpoint.method + " " + endpoint.path;
      if (keys.has(key)) throw new Error("Duplicate plug-in public endpoint: " + key);
      keys.add(key);
      const implementation = plugin?.publicEndpoints?.find((candidate) => candidate.method === endpoint.method && candidate.path === endpoint.path);
      const handle = plugin && implementation ? implementation.build(contextFor(plugin)) : null;
      if (handle !== null && typeof handle !== "function") throw new Error("Invalid plug-in endpoint handler: " + key);
      app.on(endpoint.method, endpoint.path, (context) => handle
        ? handle(context.req.raw)
        : context.json({ error: endpoint.unavailable ?? { code: "PLUGIN_ENDPOINT_UNAVAILABLE", message: "Ce module n’est pas disponible." } }, 503));
    }
  }
  return app;
}

/** A declared endpoint never shadows a core route or another plug-in endpoint. */
export function assertPublicEndpointPathsFree(loaded: readonly ProPlugin[], routes: readonly { method: string; path: string }[]): void {
  const endpoints = loaded.flatMap((plugin) => plugin.publicEndpoints ?? []);
  const own = new Set(endpoints.map((endpoint) => endpoint.method + " " + endpoint.path));
  const others = routes.filter((route) => !own.delete(route.method + " " + route.path));
  for (const endpoint of endpoints) {
    if (others.some((route) => shadowsCoreRoute(endpoint.path, [route]))) throw new Error("Plug-in public endpoint shadows a core route: " + endpoint.path);
  }
}
