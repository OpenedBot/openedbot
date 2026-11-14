import type { HermesRunDetails } from "@openedbot/hermes";

/**
 * Un run Hermes qui travaille encore, même sans rien émettre : un modèle de
 * raisonnement peut penser plusieurs minutes entre deux trames. `stopping`
 * n'en fait pas partie : l'arrêt est déjà décidé.
 */
export function isHermesRunWorking(status: HermesRunDetails["status"]): boolean {
  return status === "queued" || status === "started" || status === "running" || status === "waiting_for_approval";
}
