import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * Fenêtrage des `run_events` embarqués par `GET /api/threads/:id`.
 *
 * ## Pourquoi ce n'est pas le défaut
 *
 * Inventaire de ce que chaque client REND réellement à partir des événements :
 *
 * - `apps/console/src/components/thread-timeline.tsx` reconstruit la BULLE
 *   assistante en concaténant les deltas `agent.message` (les messages
 *   assistants persistés ne lui servent que d'`id`, de citation et de
 *   réactions). Sa recherche dans le fil fait de même
 *   (`modules/conversation/src/domain/thread-find.ts`, sans
 *   `includePersistedAssistantMessages`). Couper les deltas viderait donc le
 *   fil du web.
 * - le client natif rend les messages
 *   persistés et MASQUE déjà les deltas d'un run répondu (`answeredRuns`). Il
 *   ne leur garde qu'un usage : le curseur du premier delta visible donne son
 *   `runtimeId` (`live:<cursor>`) à la bulle finale, ce qui évite que la fin
 *   d'un run qui vient de se terminer apparaisse d'un coup. Sa recherche passe
 *   par les messages persistés.
 *
 * Conclusion : les deltas des runs terminaux ne sont inutiles QUE pour le
 * client natif, et seulement pour les runs qui ne sont plus en train de se lisser à
 * l'écran. Le fenêtrage est donc demandé par le client (`?events=compact`) et
 * le défaut reste le snapshot complet: le web garde son contrat mot pour mot.
 *
 * ## Ce que « compact » retire
 *
 * Uniquement sur les runs CONCLUS et déjà sortis de l'écran :
 * - `raw` et `agent.reasoning` : aucun des deux clients ne les rend
 *   (`RENDERLESS_EVENT_TYPES` côté web, `default: return null` côté client natif) et
 *   la recherche dans le fil les ignore explicitement.
 * - `agent.message` des runs dont la réponse est PERSISTÉE, SAUF le premier
 *   delta porteur de texte : le texte final vit dans `messages`, les deltas
 *   n'en sont qu'un doublon fragmenté: mais le curseur du premier d'entre eux
 *   est l'identifiant de rangée de la bulle côté client natif
 *   (`live:<cursor>`, `thread-rows.ts`). Le retirer ferait changer la clé de la
 *   ligne dès qu'un tour sort de la fenêtre récente, donc démonter et remonter
 *   une bulle ancienne dans une `FlatList` inversée. Un événement gardé par
 *   run coûte quelques dizaines d'octets et supprime ce défaut.
 *
 * Tout le reste passe : `tool.call`, `tool.result`, `tool.result.attached`,
 * `system.notice`, `approval.*`, `run.error`, `run.completed`, `bot.message`
 * sont rendus ou lus par au moins un des deux clients.
 */
export type ThreadEventWindow = "full" | "compact";

/**
 * Les runs les plus récents gardent TOUS leurs événements, même conclus.
 *
 * Trois et non un : un salon fait terminer plusieurs tours quasi simultanément,
 * et le run « juste fini » n'est pas forcément le dernier de la liste. En
 * dessous, un tour de salon perdrait la continuité de son lissage à l'écran.
 */
export const PRESERVED_RECENT_RUNS = 3;

/** Types d'événements qu'aucun client ne rend, jamais. */
const RENDERLESS_EVENT_TYPES = new Set(["raw", "agent.reasoning"]);

export function parseThreadEventWindow(value: string | undefined): ThreadEventWindow {
  if (value === undefined || value === "full") return "full";
  if (value === "compact") return "compact";
  // Pas de repli silencieux : un client qui se trompe de valeur croirait avoir
  // un snapshot allégé et n'en aurait pas, ou l'inverse.
  throw new HttpError(400, "INVALID_EVENT_WINDOW", "Le paramètre `events` accepte `full` ou `compact`.");
}

// Propriétés optionnelles : les lignes arrivent de PostgreSQL en
// `Record<string, unknown>`, et une colonne absente doit rester une valeur
// manquante à valider, pas une erreur de compilation.
type WindowableEvent = { runId?: unknown; type?: unknown };
type WindowableRun = { id?: unknown };
type WindowableMessage = { role?: unknown; runId?: unknown };

/**
 * Les runs dont un événement dit qu'ils sont conclus.
 *
 * Le critère est celui des DEUX clients (`run.completed` / `run.error` dans les
 * événements du run), et non le statut en base : un run que le client croit
 * encore vivant ne doit jamais se faire amputer ses événements. Un run conclu
 * hors de la fenêtre d'événements lue reste donc traité comme actif, ce qui est
 * le sens conservateur.
 */
export function concludedRunIds(events: readonly WindowableEvent[]): Set<string> {
  const concluded = new Set<string>();
  for (const event of events) {
    if (event.type === "run.completed" || event.type === "run.error") {
      if (typeof event.runId === "string") concluded.add(event.runId);
    }
  }
  return concluded;
}

/** Les runs dont la réponse assistante est écrite dans `messages`. */
export function answeredRunIds(messages: readonly WindowableMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.runId === "string") answered.add(message.runId);
  }
  return answered;
}

/**
 * Les runs intouchables : les `PRESERVED_RECENT_RUNS` derniers du fil (la liste
 * arrive triée du plus ancien au plus récent) et celui du dernier événement.
 *
 * Le second n'est pas redondant : un run né APRÈS la lecture de `runs` (tour de
 * salon, reprise) n'apparaît que dans les événements, et le web dérive son
 * indicateur d'activité de `events.at(-1).runId`.
 */
export function preservedRunIds(
  runs: readonly WindowableRun[],
  events: readonly WindowableEvent[],
): Set<string> {
  const preserved = new Set<string>();
  for (const run of runs.slice(-PRESERVED_RECENT_RUNS)) {
    if (typeof run.id === "string") preserved.add(run.id);
  }
  const last = events[events.length - 1];
  if (last && typeof last.runId === "string") preserved.add(last.runId);
  return preserved;
}

export function windowThreadEvents<T extends WindowableEvent>(
  events: readonly T[],
  options: {
    window: ThreadEventWindow;
    preservedRunIds: ReadonlySet<string>;
    concludedRunIds: ReadonlySet<string>;
    answeredRunIds: ReadonlySet<string>;
  },
): readonly T[] {
  if (options.window === "full") return events;
  // Les runs dont le delta d'ancrage est déjà gardé. L'état est local au
  // filtrage : deux appels sur le même fil rendent le même résultat.
  const anchored = new Set<string>();
  return events.filter((event) => {
    const runId = typeof event.runId === "string" ? event.runId : null;
    if (runId === null) return true;
    if (options.preservedRunIds.has(runId)) return true;
    if (!options.concludedRunIds.has(runId)) return true;
    if (RENDERLESS_EVENT_TYPES.has(String(event.type))) return false;
    if (event.type !== "agent.message" || !options.answeredRunIds.has(runId)) return true;
    // Le PREMIER delta porteur de texte reste : c'est lui qui donne son
    // identifiant de rangée à la bulle côté client natif. Les deltas vides ne
    // comptent pas: le client les ignore aussi (`eventText`).
    if (anchored.has(runId) || eventPayloadText(event) === "") return false;
    anchored.add(runId);
    return true;
  });
}

/**
 * Le texte d'un événement, lu comme les deux clients le lisent
 * (`eventText` dans `thread-rows.ts` et `thread-timeline.tsx`). Diverger ici
 * ferait garder un delta que le client juge vide, ou jeter celui sur lequel il
 * ancre sa bulle.
 */
function eventPayloadText(event: WindowableEvent): string {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const value = record.text ?? record.message ?? record.output;
  return typeof value === "string" ? value : "";
}

/**
 * Le curseur du snapshot, calculé sur les événements AVANT fenêtrage.
 *
 * Les deux clients comparent ce curseur à celui de leur flux pour décider si un
 * snapshot est périmé (`use-thread-stream.ts`). Le dériver des événements
 * RENVOYÉS ferait reculer le curseur dès qu'on retire le dernier delta d'un
 * run conclu : le client croirait son snapshot en retard et redemanderait le
 * fil en boucle: exactement le trafic que ce lot cherche à supprimer.
 *
 * Boucle et non `Math.max(...events)` : le spread d'un tableau de plusieurs
 * milliers d'entrées passe par la pile d'appel.
 */
export function snapshotCursor(events: readonly { cursor?: unknown }[]): number {
  let highest = 0;
  for (const event of events) {
    const cursor = Number(event.cursor);
    if (Number.isFinite(cursor) && cursor > highest) highest = cursor;
  }
  return highest;
}
