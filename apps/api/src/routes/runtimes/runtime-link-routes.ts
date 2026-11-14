import { Hono } from "hono";
import type { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import { runtimeLinkInternalRelay } from "@openedbot/runtime-link/application/internal-relay";
import type { InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";

/**
 * The connector-link WebSocket upgrade lives in `@openedbot/runtime-link/application/gateway`
 * and the internal relay in `@openedbot/runtime-link/application/internal-relay`, without Hono.
 * The API keeps here only the Hono mount of the relay; the gateway
 * (apps/link-gateway) mounts the same handlers on its side.
 */
export * from "@openedbot/runtime-link/application/gateway";
export { withSseKeepalive } from "@openedbot/runtime-link/application/internal-relay";

export function runtimeLinkInternalRoutes(
  internal: InternalSecretsWith<"relay">,
  broker: RuntimeLinkBroker | null,
  locator: RuntimeLinkLocator = runtimeLinkLocator(),
  options: { isDraining?: () => boolean } = {},
): Hono {
  const routes = new Hono();
  const relay = runtimeLinkInternalRelay(internal, broker, locator, options);
  routes.all("/:runtimeId/proxy/*", (context) => relay.proxy(context));
  routes.post("/:runtimeId/control", (context) => relay.control(context));
  routes.post("/:runtimeId/probe", (context) => relay.probe(context));
  return routes;
}
