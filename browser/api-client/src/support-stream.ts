import { parseEventStream } from "./api-client";

/**
 * Boucle de lecture du flux du guichet, commune au backoffice et à la console.
 *
 * `fetch` streamé plutôt qu'`EventSource`, parce qu'`EventSource` ne sait poser
 * ni en-tête (`X-OHB-Support-Token`, `Last-Event-ID`) ni `AbortSignal`. Le
 * parseur de trames est `parseEventStream`. L'URL et les en-têtes viennent de
 * l'appelant : cette boucle ne connaît aucune route.
 *
 * Deux garanties tenues ici :
 *
 * 1. Le curseur ne recule jamais. Une trame de curseur inférieur ou égal est
 *    jetée : c'est ce qui rend une reconnexion idempotente, y compris quand le
 *    serveur rejoue une page complète après une coupure.
 * 2. Une trame sans curseur (la frappe) passe sans toucher au curseur. Elle
 *    n'est pas persistée, donc la rejouer serait impossible et l'inclure dans
 *    le compteur ferait sauter une vraie trame à la reconnexion.
 */

export type SupportStreamHandle = { close: () => void };

/** Forme minimale d'une trame du guichet : le reste est opaque pour la boucle. */
export type SupportStreamFrameEvent = { conversationId: string; cursor: number };

/** Le repli de reconnexion, identique à celui du flux produit. */
export function supportBackoffMs(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
}

export type OpenSupportEventStreamInput<T extends SupportStreamFrameEvent> = {
  /** Construit l'URL de (re)connexion à partir du curseur courant. */
  url: (cursor: number) => string;
  /** En-têtes propres à l'appelant (jeton). `Accept` et `Last-Event-ID` sont posés ici. */
  headers?: Record<string, string>;
  cursor: number;
  onEvent: (event: T) => void;
  /** Vrai dès que le flux est ouvert, faux dès qu'il tombe. L'écran le dit. */
  onStatus?: (connected: boolean) => void;
  /**
   * Statuts HTTP après lesquels insister ne sert à rien (porte fermée) : le
   * flux s'arrête au lieu de marteler. Défaut : 401.
   */
  stopStatuses?: readonly number[];
  /** Filtre une trame déjà reconnue comme trame du guichet (ex. un seul fil). */
  accept?: (event: T) => boolean;
  fetchImpl?: typeof fetch;
  /** Injecté par les tests pour ne pas attendre réellement. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function openSupportEventStream<T extends SupportStreamFrameEvent>(
  input: OpenSupportEventStreamInput<T>,
): SupportStreamHandle {
  const controller = new AbortController();
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.wait ?? defaultWait;
  const stopStatuses = input.stopStatuses ?? [401];
  let cursor = input.cursor;
  let attempt = 0;

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetchImpl(input.url(cursor), {
          headers: { Accept: "text/event-stream", ...input.headers, "Last-Event-ID": String(cursor) },
          // Le cookie de session est la seconde porte : sans lui, un
          // opérateur connecté sans jeton n'ouvrirait aucun flux.
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          if (stopStatuses.includes(response.status)) {
            input.onStatus?.(false);
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        attempt = 0;
        input.onStatus?.(true);
        for await (const frame of parseEventStream(response.body)) {
          const event = frame.data as T;
          if (typeof event?.conversationId !== "string") continue;
          if (input.accept && !input.accept(event)) continue;
          if (event.cursor > 0) {
            if (event.cursor <= cursor) continue;
            cursor = event.cursor;
          }
          input.onEvent(event);
        }
        // Flux clos proprement par le serveur : on rouvre, sans compter cela
        // comme un échec.
        input.onStatus?.(false);
      } catch {
        if (controller.signal.aborted) return;
        input.onStatus?.(false);
        attempt += 1;
        await sleep(supportBackoffMs(attempt), controller.signal);
      }
    }
  };
  void run();

  return {
    close: () => {
      controller.abort();
    },
  };
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
