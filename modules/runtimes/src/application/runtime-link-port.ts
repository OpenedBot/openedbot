import { createRelayTransport, RelayDialError, type HermesTransportClientConfig, type RelayDialer, type RelayRequest } from "@openedbot/hermes";
import { RELAY_STAGE_HEADER, type RelayLinkRotateFrame, type RelayTextFrame } from "@openedbot/contracts-connector";
import type { LinkProbeResult } from "../domain/link-probe";

/**
 * The connector link as reading a runtime needs it (ADR 0001 S4): whether it
 * is open here, how to dial it, where it lives otherwise, and the registries
 * the API and the link gateway install at boot. The link itself (broker,
 * locator, relay) is `modules/runtime-link`, which sits above this module and
 * implements these types; nothing here imports it.
 */

/** En-tête posé sur une réponse qui décrit une panne du LIEN, pas une réponse gateway. */
export const RUNTIME_LINK_RELAY_STAGE_HEADER = RELAY_STAGE_HEADER;

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

export type LinkUnavailableDetail = "instance_dead" | "no_link";

export type LinkLocation =
  | { kind: "local" }
  | { kind: "remote"; instanceId: string; internalUrl: string }
  | { kind: "unavailable"; detail: LinkUnavailableDetail };

export type RuntimeLinkLocator = {
  instanceId: string;
  locate(runtimeId: string): Promise<LinkLocation>;
  /** Relais HTTP vers l'instance propriétaire (même chemin, même bearer, hop=1). */
  forwardProxy(runtimeId: string, request: Request): Promise<Response>;
  forwardDial(runtimeId: string, request: RelayRequest, signal?: AbortSignal): Promise<Response>;
  /**
   * `"unknown"` : la trame a peut-être été écrite (saut expiré, réponse
   * perdue ou illisible). L'appelant ne doit pas défaire la rotation.
   */
  forwardRotate(runtimeId: string, frame: RelayLinkRotateFrame): Promise<ControlPush>;
  forwardClose(runtimeId: string, code: number, reason: string): Promise<boolean>;
  /** Sonde le lien sur l'instance propriétaire ; attend son verdict, borné. */
  forwardProbe(runtimeId: string, expectedGeneration: string | null): Promise<LinkProbeResult>;
};

/** Issue d'une trame de contrôle poussée : certaine (`true`/`false`) ou inconnue. */
export type ControlPush = boolean | "unknown";

export const NO_RUNTIME_LINK_LOCATOR: RuntimeLinkLocator = {
  instanceId: "",
  locate: async () => ({ kind: "unavailable", detail: "no_link" }),
  forwardProxy: async () => unavailableResponse("no_link"),
  forwardDial: async () => {
    throw unavailableDial("no_link");
  },
  forwardRotate: async () => false,
  forwardClose: async () => false,
  forwardProbe: async () => ({ outcome: "no_link" }),
};

let installedLocator: RuntimeLinkLocator = NO_RUNTIME_LINK_LOCATOR;

export function installRuntimeLinkLocator(locator: RuntimeLinkLocator): void {
  installedLocator = locator;
}

export function runtimeLinkLocator(): RuntimeLinkLocator {
  return installedLocator;
}

export function unavailableDial(detail: LinkUnavailableDetail, cause?: unknown): RelayDialError {
  return new RelayDialError(unavailableMessage(detail), "before_dispatch", "RUNTIME_LINK_UNAVAILABLE", cause ? { cause } : undefined);
}

export function unavailableMessage(detail: LinkUnavailableDetail): string {
  return detail === "instance_dead"
    ? "L’instance qui tenait le lien connecteur ne répond plus."
    : "Ce runtime n’a pas de lien connecteur ouvert.";
}

export function unavailableResponse(detail: LinkUnavailableDetail, status = 503): Response {
  return Response.json(
    { error: { code: "RUNTIME_LINK_UNAVAILABLE", message: unavailableMessage(detail), stage: "before_dispatch", detail } },
    { status, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch", "Cache-Control": "no-store" } },
  );
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
