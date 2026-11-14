import type { RuntimeLinkBroker } from "./broker";
import { instanceAwareDial, runtimeLinkLocator, type RuntimeLinkLocator } from "./instances";
import type { RuntimeLinks } from "@openedbot/runtimes/application/runtime-link-port";

/**
 * The link registry and the relay client config live in `modules/runtimes`
 * (`application/runtime-link-port`), so that reading a runtime needs no link
 * code. Re-exported here, where the API and the tests find them.
 */
export {
  installRuntimeLinks,
  NO_RUNTIME_LINKS,
  runtimeLinkClientConfig,
  runtimeLinks,
  type RuntimeLinks,
} from "@openedbot/runtimes/application/runtime-link-port";

/** Les liens tels que le broker de CETTE instance les tient. */
export function brokerRuntimeLinks(broker: RuntimeLinkBroker): RuntimeLinks {
  return {
    connected: (runtimeId) => broker.connected(runtimeId),
    dial: (runtimeId) => broker.dialer(runtimeId),
    revoke: (runtimeId) => broker.revoke(runtimeId),
    notifyRotation: (runtimeId, frame) => broker.notifyRotation(runtimeId, frame),
    close: (runtimeId, code, reason) => broker.closeLink(runtimeId, code, reason),
    pushFrame: (runtimeId, frame) => broker.notifyRotation(runtimeId, frame),
    probe: (runtimeId, expectedGeneration) => broker.connected(runtimeId) ? broker.probeLink(runtimeId, expectedGeneration) : null,
  };
}

/**
 * Dialer qui parle au broker local, ou relaie vers l'instance propriétaire
 * si le lien est monté ailleurs. `connected()` reste local au processus.
 */
export function instanceAwareRuntimeLinks(local: RuntimeLinks, locator: RuntimeLinkLocator = runtimeLinkLocator()): RuntimeLinks {
  return {
    connected: (runtimeId) => local.connected(runtimeId),
    dial: (runtimeId) =>
      instanceAwareDial(() => local.dial(runtimeId), () => local.connected(runtimeId), locator, runtimeId),
    revoke: (runtimeId) => local.revoke(runtimeId),
    notifyRotation: (runtimeId, frame) => local.notifyRotation(runtimeId, frame),
    close: (runtimeId, code, reason) => local.close(runtimeId, code, reason),
    pushFrame: (runtimeId, frame) => local.pushFrame?.(runtimeId, frame) ?? false,
    probe: (runtimeId, expectedGeneration) => local.probe?.(runtimeId, expectedGeneration) ?? null,
  };
}
