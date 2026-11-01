import {
  createRelayTransport,
  RelayDialError,
  type HermesTransportClientConfig,
  type RelayDialer,
} from "@openedbot/hermes";
import type { RelayLinkRotateFrame, RelayTextFrame } from "@openedbot/contracts-connector";
import type { RuntimeLinkBroker } from "./broker";
import type { LinkProbeResult } from "../domain/link-probe";
import {
  instanceAwareDial,
  runtimeLinkLocator,
  type RuntimeLinkLocator,
} from "./instances";

/**
 * Ce que les routes de l'API demandent au lien connecteur : est-il ouvert
 * ICI, comment lui parler, et comment le fermer quand le runtime est révoqué.
 *
 * Le broker vit dans le processus ; les routes reçoivent `db` et `config`
 * mais pas lui. Plutôt que d'enfiler un paramètre de plus dans une dizaine
 * d'appelants de `readRuntimeSecret`, l'instance active est installée une
 * fois au démarrage (`installRuntimeLinks`) et les tests injectent la leur.
 */
export type RuntimeLinks = {
  connected(runtimeId: string): boolean;
  dial(runtimeId: string): RelayDialer;
  revoke(runtimeId: string): boolean;
  /** Pousse `link.rotate` sur le lien ouvert ici ; `false` s'il n'y en a pas (l'hôte reprendra l'ancien jeton pendant la grâce). */
  notifyRotation(runtimeId: string, frame: RelayLinkRotateFrame): boolean;
  /** Ferme le lien ouvert ici avec ce code ; `false` s'il n'y en a pas. */
  close(runtimeId: string, code: number, reason: string): boolean;
  /** Pousse une trame de contrôle (`audit.key` à la rotation) sur le lien ouvert ICI ; `false` sinon : la session suivante la reçoit à la liaison. */
  pushFrame?(runtimeId: string, frame: RelayTextFrame): boolean;
  /** Sonde le lien tenu ICI (`probeLink`) ; `null` s'il n'est pas ici, l'appelant forwarde alors. */
  probe?(runtimeId: string, expectedGeneration: string | null): Promise<LinkProbeResult> | null;
};

/** Sans broker installé (tests unitaires, scripts) : aucun lien n'est jamais ouvert. */
export const NO_RUNTIME_LINKS: RuntimeLinks = {
  connected: () => false,
  dial: (runtimeId) => () =>
    Promise.reject(
      new RelayDialError(`Aucun broker de lien n'est installé pour le runtime ${runtimeId}.`, "before_dispatch", "RUNTIME_LINK_UNAVAILABLE"),
    ),
  revoke: () => false,
  notifyRotation: () => false,
  close: () => false,
  pushFrame: () => false,
};

let installed: RuntimeLinks = NO_RUNTIME_LINKS;

export function installRuntimeLinks(links: RuntimeLinks): void {
  installed = links;
}

export function runtimeLinks(): RuntimeLinks {
  return installed;
}

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

/** La configuration client d'un runtime `connector` : un transport `relay`, ni URL ni bearer. */
export function runtimeLinkClientConfig(
  runtimeId: string,
  links: RuntimeLinks,
  profile: string | null = null,
): HermesTransportClientConfig {
  return {
    transport: createRelayTransport({ runtimeId, dial: links.dial(runtimeId) }),
    profile,
  };
}
