import { Hono } from "hono";
import type { InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import type { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import type { RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import { runtimeLinkInternalRelay } from "@openedbot/runtime-link/application/internal-relay";

/**
 * Le montage Hono du relais interne de la passerelle. Les gestionnaires vivent
 * dans `@openedbot/runtime-link/application/internal-relay` ; l'API monte les mêmes sous le même
 * préfixe.
 */
export function runtimeLinkInternalRoutes(
  internal: InternalSecretsWith<"relay">,
  broker: RuntimeLinkBroker,
  locator: RuntimeLinkLocator,
  options: { isDraining?: () => boolean } = {},
): Hono {
  const routes = new Hono();
  const relay = runtimeLinkInternalRelay(internal, broker, locator, options);
  routes.all("/:runtimeId/proxy/*", (context) => relay.proxy(context));
  routes.post("/:runtimeId/control", (context) => relay.control(context));
  routes.post("/:runtimeId/probe", (context) => relay.probe(context));
  return routes;
}
