import {
  openSupportEventStream,
  supportBackoffMs,
  type SupportStreamHandle,
} from "@openedbot/browser-api-client/support-stream";
import type { SupportEventDto } from "@openedbot/contracts-api";
import { API_ORIGIN } from "../api";
import { nativeBridge, withClientHeaders, type OpenedbotNativeBridge } from "../platform";
import { reportingClientUpdate } from "../platform/client-update";

/**
 * Le flux du guichet, côté visiteur.
 *
 * Même forme que `use-thread-stream.ts` et pour les mêmes raisons : `fetch`
 * streamé plutôt qu'`EventSource`. La boucle (parseur de trames, curseur qui ne
 * recule jamais, trame de frappe sans curseur, repli) est celle de
 * `@openedbot/browser-api-client/support-stream`, partagée avec le backoffice.
 *
 * Une différence : un seul fil à la fois, donc pas de multiplexage ni de
 * dédoublonnage inter-abonnés. Le curseur suffit, et les trames d'un autre fil
 * sont écartées ici.
 */

export type SupportStreamHandlers = {
  onEvent: (event: SupportEventDto) => void;
  /** Vrai dès que le flux est ouvert, faux dès qu'il tombe. L'écran le dit. */
  onStatus?: (connected: boolean) => void;
};

export { supportBackoffMs };
export type { SupportStreamHandle };

export function openSupportStream(input: {
  conversationId: string;
  /**
   * `null` quand c'est le COMPTE qui ouvre le fil : un opérateur connecté n'a
   * pas de jeton sur cette machine, et son cookie de session suffit (porte
   * compte, migration 0078). Un en-tête vide serait lu comme un jeton
   * difforme, donc il n'est pas posé.
   */
  token: string | null;
  cursor: number;
  handlers: SupportStreamHandlers;
  fetchImpl?: typeof fetch;
  /** Injecté par les tests pour ne pas attendre réellement. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): SupportStreamHandle {
  return openSupportEventStream<SupportEventDto>({
    url: (cursor) => `${API_ORIGIN}/api/support/conversations/${input.conversationId}/events?cursor=${cursor}`,
    headers: input.token ? { "X-OpenedBot-Support-Token": input.token } : undefined,
    cursor: input.cursor,
    onEvent: input.handlers.onEvent,
    onStatus: input.handlers.onStatus,
    // Un 401 ou un 404 veut dire que ce jeton n'ouvre plus rien : insister ne
    // le fera pas revenir, et le panneau doit repartir de son instantané plutôt
    // que de boucler sur une porte fermée.
    // Un 426 : l'app de bureau est trop vieille, l'écran de mise à jour prend le relais.
    stopStatuses: [401, 404, 426],
    accept: (event) => event.conversationId === input.conversationId,
    fetchImpl: reportingClientUpdate(withNativeBearer(input.fetchImpl ?? fetch, nativeBridge())),
    wait: input.wait,
  });
}

/**
 * Dans la coque, la session est un Bearer, pas un cookie : sans lui, un compte
 * connecté qui ouvre son fil sans jeton de guichet prend un 401 et le flux
 * s'arrête. Le jeton est relu à chaque (re)connexion, parce qu'il tourne.
 */
function withNativeBearer(fetchImpl: typeof fetch, bridge: OpenedbotNativeBridge | null): typeof fetch {
  if (!bridge) return fetchImpl;
  const authorized = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const token = await bridge.readAccessToken();
    const headers = new Headers(withClientHeaders(init)?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(url, { ...init, headers, credentials: "omit" });
  };
  // La boucle n'appelle que `fetch(url, init)` : le reste de `typeof fetch` ne sert pas.
  return authorized as typeof fetch;
}
