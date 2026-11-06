import { QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import { isUnauthorized, isWorkspaceChanged } from "./api";
import { isRestoredQueryData, persistQueryFn } from "./query-persister";

/**
 * Un 401 ne se rejoue pas : la réponse ne changera pas sans nouveau jeton, et
 * le second essai ne ferait que retarder l'étape « Se connecter ».
 * `WORKSPACE_CHANGED` non plus : le nouvel essai relirait l'espace devenu
 * actif et rangerait sa réponse sous la clé de l'ancien. Le reste garde son
 * unique nouvel essai.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isUnauthorized(error) && !isWorkspaceChanged(error) && failureCount < 1;
}

const localPatches = new WeakSet<object>();

/**
 * Marque une valeur construite EN PATCHANT celle du cache (le flux du fil,
 * `useThreadStream`) : elle partage déjà la structure de l'ancienne, objet par
 * objet. Le partage structurel par défaut la recopierait conteneur par
 * conteneur (un nouveau tableau d'événements par patch) et casserait ce qui
 * se fie à son identité : l'index des clés d'événements et la reconnaissance
 * d'un ajout en queue (`eventsAppendedFrom`), qui évitent tous deux de
 * reparcourir le fil à chaque patch.
 */
export function asLocalPatch<T extends object>(data: T): T {
  localPatches.add(data);
  return data;
}

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
      retry: shouldRetryQuery,
      // Un second observateur après le garde de route ne doit pas refetch.
      staleTime: 10_000,
      // Roster and threads only survive a refresh (`lib/query-persister.ts`);
      // every other key passes straight through.
      persister: persistQueryFn,
      // The first network read after a restore must hand out a new object even
      // when nothing changed: that reference is what tells the thread its
      // snapshot is live and lets the stream start. A local patch
      // (`asLocalPatch`) already shares the cached structure: kept as is.
      structuralSharing: (previous, next) => (
        isRestoredQueryData(previous) || (typeof next === "object" && next !== null && localPatches.has(next))
          ? next
          : replaceEqualDeep(previous, next)
      ),
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
