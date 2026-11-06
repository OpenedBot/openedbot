import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { joinsLiveText, lastRunSequence, type ThreadLiveText } from "../lib/stream/live-run-text";
import type { Entry } from "../lib/thread/thread-timeline-model";

const NO_SUBSCRIPTION = () => () => {};

/**
 * Une réponse du fil. Celle qu'un run écrit encore reçoit `live` et devient
 * la seule entrée de la timeline abonnée au texte en cours
 * (`live-run-text.ts`) : ses fragments la re-rendent, elle seule, sans
 * repasser par le snapshot, la timeline ni l'écran. `render` est le rendu
 * d'entrée de la timeline, appliqué au texte complet : découpe d'une
 * question, directive de transmission et bulle vide se décident comme si le
 * snapshot avait tout.
 *
 * Toutes les réponses passent par ce composant, en direct ou non : une
 * réponse qui cesse d'être en direct garde ainsi son arbre (son lissage, ses
 * blocs déjà parsés) au lieu d'être remontée. `live` est une prop, pas un
 * contexte : les autres réponses, servies par le cache de la timeline, ne
 * re-rendent pas quand le snapshot change.
 */
export function LiveTimelineEntry({ entry, live, render }: {
  entry: Extract<Entry, { kind: "assistant" }>;
  live: ThreadLiveText | null;
  render: (entry: Entry) => ReactNode;
}): ReactNode {
  const store = live?.store ?? null;
  // Le dernier événement de ce run dans le snapshot rendu : le texte au-delà vient du store.
  const events = live?.events;
  const after = useMemo(() => (events ? lastRunSequence(events, entry.runId) : -1), [events, entry.runId]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(entry.runId, listener) ?? NO_SUBSCRIPTION(),
    [store, entry.runId],
  );
  const read = () => store?.textAfter(entry.runId, after) ?? "";
  const suffix = useSyncExternalStore(subscribe, read, read);
  // Une balise `MEDIA:` à cheval sur le snapshot et le suffixe : le snapshot seul, jusqu'au prochain patch.
  return render(suffix && joinsLiveText(entry.text, suffix) ? { ...entry, text: entry.text + suffix } : entry);
}
