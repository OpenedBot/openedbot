import { QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import { isUnauthorized } from "./api";
import { isRestoredQueryData, persistQueryFn } from "./query-persister";

/**
 * Singleton TanStack Query de l'app. Le garde de route y dépose
 * `GET /api/auth/me` ; la carte du compte (`account-menu.tsx`) et les autres observateurs lisent ce cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Le cloud API est en loopback : une requête coûte une milliseconde, mais
      // refetch au focus ferait clignoter un fil en cours de streaming.
      refetchOnWindowFocus: false,
      // Un 401 ne se rejoue pas : la réponse ne changera pas sans nouveau
      // jeton, et le second essai ne ferait que retarder l'étape « Se
      // connecter ». Le reste garde son unique nouvel essai.
      retry: (count, error) => !isUnauthorized(error) && count < 1,
      // Un second observateur après le garde de route ne doit pas refetch.
      staleTime: 10_000,
      // Roster and threads only survive a refresh (`lib/query-persister.ts`);
      // every other key passes straight through.
      persister: persistQueryFn,
      // The first network read after a restore must hand out a new object even
      // when nothing changed: that reference is what tells the thread its
      // snapshot is live and lets the stream start.
      structuralSharing: (previous, next) => (isRestoredQueryData(previous) ? next : replaceEqualDeep(previous, next)),
    },
  },
});

export const DEFAULT_INVALIDATE_DELAY_MS = 250;

type TimerHandle = ReturnType<typeof setTimeout>;

export type InvalidateScheduler = {
  /**
   * Programme UNE invalidation de `queryKey` d'ici `delayMs`. Les appels qui
   * suivent pour la même clé pendant ce délai sont absorbés : ils ne
   * repoussent pas l'échéance, sinon un flux qui émet toutes les 50 ms
   * repousserait la relecture jusqu'à la fin du run.
   */
  schedule(queryKey: readonly unknown[], delayMs?: number): void;
  /** Nombre de clés en attente : pour les tests et le diagnostic. */
  pending(): number;
};

/**
 * Fabrique du coalesceur, séparée du singleton pour être testable sans
 * horloge réelle : les tests fournissent leurs propres minuteries.
 */
export function createInvalidateScheduler(deps: {
  invalidate: (queryKey: readonly unknown[]) => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
}): InvalidateScheduler {
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const timers = new Map<string, TimerHandle>();
  return {
    schedule(queryKey, delayMs = DEFAULT_INVALIDATE_DELAY_MS) {
      const id = JSON.stringify(queryKey);
      if (timers.has(id)) return;
      timers.set(id, setTimer(() => {
        timers.delete(id);
        deps.invalidate(queryKey);
      }, delayMs));
    },
    pending() {
      return timers.size;
    },
  };
}

const streamInvalidations = createInvalidateScheduler({
  // `cancelRefetch: false` : une relecture déjà en vol reste valable. La
  // relancer à chaque événement (comportement par défaut) annulait la requête
  // précédente et repartait de zéro : d'où la rafale de `GET /api/bots` qu'un
  // seul run en streaming suffisait à déclencher.
  invalidate: (queryKey) => {
    void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  },
});

/**
 * Invalidation coalescée, pour ce que le flux SSE déclenche.
 *
 * Les mutations de l'utilisateur (envoi, approbation, renommage) gardent leur
 * `invalidateQueries` immédiat : elles arrivent une à la fois et la réponse
 * doit se voir tout de suite. Le flux, lui, livre des dizaines d'événements
 * par seconde pendant une génération : une relecture par événement ne montre
 * rien de plus qu'une relecture par quart de seconde.
 */
export function scheduleInvalidate(queryKey: readonly unknown[], delayMs = DEFAULT_INVALIDATE_DELAY_MS): void {
  streamInvalidations.schedule(queryKey, delayMs);
}
