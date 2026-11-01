import { Hono } from "hono";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import type { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import type { RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import { runtimeLinkInternalRelay } from "@openedbot/runtime-link/application/internal-relay";

/**
 * Le montage Hono du relais interne de la passerelle. Les gestionnaires vivent
 * dans `@openedbot/runtime-link/application/internal-relay` ; l'API monte les mêmes sous le même
 * préfixe.
 */
export function runtimeLinkInternalRoutes(
  config: ApiConfig,
  broker: RuntimeLinkBroker,
  locator: RuntimeLinkLocator,
  options: { isDraining?: () => boolean } = {},
): Hono {
  const routes = new Hono();
  const relay = runtimeLinkInternalRelay(config, broker, locator, options);
  routes.all("/:runtimeId/proxy/*", (context) => relay.proxy(context));
  routes.post("/:runtimeId/control", (context) => relay.control(context));
  routes.post("/:runtimeId/probe", (context) => relay.probe(context));
  return routes;
}
