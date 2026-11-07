import { Hono } from "hono";
import type { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import { runtimeLinkInternalRelay } from "@openedbot/runtime-link/application/internal-relay";
import type { InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";

/**
 * La montée WebSocket du lien connecteur vit dans `@openedbot/runtime-link/application/gateway`
 * et le relais interne dans `@openedbot/runtime-link/application/internal-relay`, sans Hono.
 * L'API ne garde ici que le montage Hono du relais ; la passerelle
 * (apps/link-gateway) monte les mêmes gestionnaires de son côté.
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
