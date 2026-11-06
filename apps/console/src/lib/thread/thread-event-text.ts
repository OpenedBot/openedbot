import type { StoredProductEvent } from "@openedbot/contracts-events";
import { SUPERSEDED_NOTICE_KIND } from "@openedbot/conversation/domain/followup";

/**
 * Ce que le modèle de la timeline (`thread-timeline-model.ts`) lit d'un
 * événement pour le rendre, hors du modèle : le flux du fil
 * (`lib/stream/live-run-text.ts`) en a besoin dès le premier chargement, et
 * le modèle entier n'a rien à y faire.
 */

export function eventText(event: StoredProductEvent): string {
  const value = event.payload.text ?? event.payload.message ?? event.payload.output;
  return typeof value === "string" ? value : "";
}

/**
 * Les événements dont le `switch` de rendu (`thread-timeline.tsx`) ne fait
 * RIEN : soit déjà rendus ailleurs (`tool.result`/`tool.result.attached` via
 * le chip du `tool.call`, `approval.requested` via la gate ancrée dans le
 * flux, `bot.message` via `messages`), soit sans valeur d'affichage propre
 * (`agent.reasoning`, `raw`, `run.completed`). Miroir exact de ce switch : un
 * type qui y gagne un rendu doit sortir d'ici.
 */
const RENDERLESS_EVENT_TYPES = new Set<StoredProductEvent["type"]>([
  "agent.reasoning",
  "tool.result",
  "tool.result.attached",
  "approval.requested",
  // La GateCard porte déjà la décision. Rendu, cet événement vide coupait
  // l'activité du tour : un outil appelé après une validation sortait du bloc.
  "approval.responded",
  "run.completed",
  "bot.message",
  "raw",
]);

/** `system.notice` n'est muet QUE pour `group.pass` : les autres se rendent en repère. */
export function rendersNothing(event: StoredProductEvent): boolean {
  return (
    RENDERLESS_EVENT_TYPES.has(event.type) ||
    (event.type === "system.notice" && (
      event.payload.kind === "group.pass" || event.payload.kind === "memory.fact"
      // Un run remplacé par le message suivant (rafale) : son message reste,
      // le repère se tait : rien n'a échoué.
      || event.payload.kind === SUPERSEDED_NOTICE_KIND
      // Fils d'avant le 2026-10-07 : la fin de salon n'est plus un repère.
      || (event.payload.kind === "group.settled" && eventText(event) === "Le salon se calme.")
    ))
  );
}
