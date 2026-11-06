import type { StoredProductEvent } from "@openedbot/contracts-events";
import { eventText, rendersNothing } from "@/lib/thread/thread-event-text";
import { LIVE_NARRATION_MAX } from "./live-answer";

/**
 * Le texte d'une réponse en cours d'écriture, tenu HORS du cache du fil
 * (D1c, `docs/architecture/0001-refonte-tauri-et-produit.md`, section 4.4).
 *
 * Chaque fragment `agent.message` patché dans le snapshot du fil re-rendait
 * tout l'écran de conversation : l'en-tête, la barre latérale (le roster
 * bouge avec), la timeline et son modèle, plusieurs passes O(n) sur les
 * événements du fil. Pendant qu'une réponse confirmée s'allonge, ses
 * fragments sont donc retenus par `useThreadStream` (`LiveTextHold`) ; seule
 * la bulle de cette réponse s'abonne à ce store (`LiveTimelineEntry`). Le
 * snapshot les reçoit tous, dans l'ordre du flux, au plus tard
 * `LIVE_TEXT_COMMIT_MS` plus tard, ou avant tout autre événement.
 *
 * Le store recopie le texte de CHAQUE run du fil ouvert, retenu ou non, avec
 * ses coupures (un appel d'outil, une notice…). La bulle affiche `son texte
 * dans le snapshot + le texte du run après le dernier événement de ce run
 * dans ce snapshot, jusqu'à la première coupure` : exactement ce que le
 * modèle de la timeline y ajouterait. Le repère est la `sequence` du run, pas
 * le curseur : les fragments de texte arrivent avant leur commit, sans
 * curseur (`api-client.ts`), et ne font pas avancer celui du snapshot. Le
 * couple vient d'un même rendu, et le store est toujours en avance sur le
 * snapshot (il est nourri avant le patch) : même une bulle re-rendue par le
 * store avec les props d'un snapshot plus ancien affiche le bon texte, sans
 * doublon ni recul.
 */

/** Le store du fil ouvert et les événements du snapshot rendu avec lui : ce que lit `LiveTimelineEntry`. */
export type ThreadLiveText = { store: LiveRunText; events: readonly StoredProductEvent[] };

/** Au plus ce délai entre deux patchs du snapshot pendant une réponse. */
export const LIVE_TEXT_COMMIT_MS = 1_000;

/** Les runs gardés (un salon en écrit plusieurs à la fois) ; les plus anciens sont oubliés. */
const KEPT_RUNS = 4;

/** Une balise `MEDIA:` change le texte rendu (`withoutMediaLines`) : elle coupe. */
const MEDIA_TAG = "MEDIA:";

type RunText = {
  sequences: number[];
  texts: string[];
  /** Séquences des coupures, croissantes. */
  breaks: number[];
  /** La fin du texte recopié, pour voir une balise coupée entre deux fragments. */
  tail: string;
  listeners: Set<() => void>;
  cache: { after: number; length: number; breaks: number; text: string } | null;
};

export type LiveRunText = {
  /**
   * Le texte du run après sa séquence `after` (son dernier événement dans le
   * snapshot que l'appelant affiche, `lastRunSequence`), jusqu'à la première
   * coupure.
   */
  textAfter(runId: string, after: number): string;
  subscribe(runId: string, listener: () => void): () => void;
  /** Côté flux : un événement du fil ouvert, dans l'ordre du flux, sans notifier. */
  record(event: StoredProductEvent): void;
  /** Notifie les abonnés des runs qui ont reçu du texte depuis le dernier appel. */
  publish(): void;
};

export function createLiveRunText(): LiveRunText {
  const runs = new Map<string, RunText>();
  const touched = new Set<string>();
  const runText = (runId: string): RunText => {
    let run = runs.get(runId);
    if (run) return run;
    run = { sequences: [], texts: [], breaks: [], tail: "", listeners: new Set(), cache: null };
    runs.set(runId, run);
    // Oublier un run n'enlève rien à une bulle qui l'affiche encore : il ne
    // reçoit plus rien, donc plus de notification, et son prochain rendu
    // viendra d'un snapshot qui contient déjà tout son texte.
    for (const id of runs.keys()) {
      if (runs.size <= KEPT_RUNS) break;
      if (runs.get(id)!.listeners.size === 0) runs.delete(id);
    }
    return run;
  };
  const cut = (run: RunText, sequence: number) => {
    if (sequence > (run.breaks.at(-1) ?? Number.NEGATIVE_INFINITY)) run.breaks.push(sequence);
    run.tail = "";
  };
  return {
    textAfter(runId, after) {
      const run = runs.get(runId);
      if (!run || run.sequences.length === 0) return "";
      const cached = run.cache;
      if (cached && cached.after === after && cached.length === run.sequences.length && cached.breaks === run.breaks.length) {
        return cached.text;
      }
      const limit = run.breaks.find((at) => at > after) ?? Number.POSITIVE_INFINITY;
      const parts: string[] = [];
      for (let index = run.sequences.length - 1; index >= 0 && run.sequences[index]! > after; index -= 1) {
        if (run.sequences[index]! < limit) parts.push(run.texts[index]!);
      }
      const text = parts.reverse().join("");
      run.cache = { after, length: run.sequences.length, breaks: run.breaks.length, text };
      return text;
    },
    subscribe(runId, listener) {
      const run = runText(runId);
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },
    record(event) {
      const run = runText(event.runId);
      const sequence = event.sequence;
      // Une séquence déjà vue (rejeu) ou illisible n'apprend rien au store.
      if (!Number.isSafeInteger(sequence) || sequence <= Math.max(run.sequences.at(-1) ?? -1, run.breaks.at(-1) ?? -1)) return;
      if (event.type === "agent.message") {
        const text = eventText(event);
        if (`${run.tail}${text}`.includes(MEDIA_TAG)) return cut(run, sequence);
        run.sequences.push(sequence);
        run.texts.push(text);
        run.tail = `${run.tail}${text}`.slice(-(MEDIA_TAG.length - 1));
        touched.add(event.runId);
        return;
      }
      // Les événements sans rendu ne coupent pas la bulle (`mergeTimelineEntries`),
      // sauf ceux qui peuvent en changer le texte ou la place : une notice
      // (un « pass » de salon masque le run), une demande d'approbation.
      if (rendersNothing(event) && event.type !== "system.notice" && event.type !== "approval.requested") return;
      cut(run, sequence);
    },
    publish() {
      for (const runId of touched) for (const listener of runs.get(runId)?.listeners ?? []) listener();
      touched.clear();
    },
  };
}

/** La séquence du dernier événement du run dans `events` (-1 : aucun). */
export function lastRunSequence(events: readonly StoredProductEvent[], runId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.runId === runId) return events[index]!.sequence;
  }
  return -1;
}

/**
 * Le fragment `event` peut-il OUVRIR une retenue, vu le snapshot du fil ?
 *
 * Seulement quand la fin du fil est déjà la réponse confirmée de ce run : le
 * dernier événement est un `agent.message` du même run, et le texte que le
 * modèle de la timeline fusionne avec lui (`mergeTimelineEntries` : ses
 * fragments, par-dessus les événements sans rendu) dépasse
 * `LIVE_NARRATION_MAX`. Le suffixe s'ajoute alors à une bulle qui reste la
 * réponse : rien de ce que la timeline décide sur ce texte (narration ou
 * réponse, bloc d'activité, bulle vide) ne peut changer avec lui. Seule la
 * longueur compte, pas la forme (`isConfirmedLiveAnswer`) : le texte
 * parcouru ici peut être plus court que celui du modèle, jamais plus long,
 * et une forme lue sur un suffixe pourrait mentir.
 *
 * Refusé dans le doute : une notice du run (un « pass » de salon masque tout
 * son texte), une demande d'approbation (elle coupe la bulle quand elle est
 * ouverte), une balise `MEDIA:` dans le texte.
 */
export function canStartLiveText(events: readonly StoredProductEvent[], event: StoredProductEvent): boolean {
  return liveTextBubble(events, event) !== null;
}

/** Le texte de la bulle que `event` prolongerait, ou `null` s'il ne peut pas ouvrir de retenue. */
function liveTextBubble(events: readonly StoredProductEvent[], event: StoredProductEvent): string | null {
  const last = events.at(-1);
  if (last?.type !== "agent.message" || last.runId !== event.runId) return null;
  const parts: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]!;
    if (candidate.runId !== event.runId) continue;
    if (candidate.type === "agent.message") {
      parts.push(eventText(candidate));
      continue;
    }
    if (candidate.type === "system.notice" || candidate.type === "approval.requested") return null;
    if (!rendersNothing(candidate)) break;
  }
  const text = parts.reverse().join("");
  if (`${text}${eventText(event)}`.includes(MEDIA_TAG)) return null;
  return text.trim().length > LIVE_NARRATION_MAX ? text : null;
}

/**
 * Le suffixe peut-il s'ajouter tel quel au texte affiché ? Non si une balise
 * `MEDIA:` se forme à la jonction (« …MED » + « IA:/… ») : le snapshot la
 * traitera (`withoutMediaLines`), le suffixe brut l'afficherait.
 */
export function joinsLiveText(text: string, suffix: string): boolean {
  return !`${text.slice(-(MEDIA_TAG.length - 1))}${suffix}`.includes(MEDIA_TAG);
}

/**
 * La retenue côté flux : les fragments `agent.message` que `useThreadStream`
 * ne patche pas encore dans le snapshot. Ils forment toujours la fin du flux
 * du fil, d'un seul run : tout autre événement les fait d'abord relâcher
 * (`release`), pour que le snapshot les reçoive dans l'ordre exact du flux.
 */
export type LiveTextHold = {
  /**
   * Retient `event`, un événement du fil ouvert (vrai) ; faux si l'appelant
   * doit relâcher la retenue puis l'appliquer.
   */
  offer(event: StoredProductEvent, snapshot: { events: readonly StoredProductEvent[] } | undefined): boolean;
  /** Les fragments retenus, dans l'ordre ; la retenue se vide. */
  release(): StoredProductEvent[];
  /** Millisecondes avant que la retenue soit due (0 : due), `null` si elle est vide. */
  dueIn(now: number): number | null;
};

export function createLiveTextHold(clock: () => number): LiveTextHold {
  let held: StoredProductEvent[] = [];
  let tail = "";
  let since = 0;
  return {
    offer(event, snapshot) {
      if (event.type !== "agent.message" || !snapshot || !Number.isSafeInteger(event.sequence)) return false;
      const text = eventText(event);
      const first = held[0];
      if (first) {
        // Un snapshot relu qui couvre déjà la retenue : elle se relâche (les
        // doublons sont écartés au patch) et tout repart de ce snapshot.
        if (first.runId !== event.runId || `${tail}${text}`.includes(MEDIA_TAG)) return false;
        if (lastRunSequence(snapshot.events, event.runId) >= first.sequence) return false;
      } else {
        if (event.sequence <= lastRunSequence(snapshot.events, event.runId)) return false;
        const bubble = liveTextBubble(snapshot.events, event);
        if (bubble === null) return false;
        since = clock();
        // La fin de la bulle compte : une balise peut commencer dans le snapshot.
        tail = bubble.slice(-(MEDIA_TAG.length - 1));
      }
      held.push(event);
      tail = `${tail}${text}`.slice(-(MEDIA_TAG.length - 1));
      return true;
    },
    release() {
      const released = held;
      held = [];
      tail = "";
      return released;
    },
    dueIn(now) {
      return held.length === 0 ? null : Math.max(0, since + LIVE_TEXT_COMMIT_MS - now);
    },
  };
}
