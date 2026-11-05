/**
 * Les événements `(from, to]` ne seront pas rendus sur cette connexion : le
 * client relit fil, roster et courrier par HTTP.
 *
 * - sans `reason` : annoncé en tête de flux, la borne de rejeu a relevé le
 *   curseur demandé ;
 * - `slow_consumer` : dernière trame avant fermeture, le client ne lisait pas
 *   assez vite. Il se reconnecte à son curseur (`from`), le rejeu rend ce qui
 *   tient encore dans la fenêtre.
 */
export type StreamGap = { organizationId: string; from: number; to: number; reason?: "slow_consumer" };

/**
 * Flux filtré par fil (`?threadId=`) : le serveur a écarté, faute de filtre
 * correspondant, tout ce qui va jusqu'à `cursor` inclus. Porte `id:` : le
 * curseur de reprise avance sans événement rendu, et une reconnexion ne
 * rejoue pas (ni n'annonce comme trou) ce qui ne concernait pas ce client.
 */
export type StreamCursor = { organizationId: string; cursor: number };

/**
 * Version de l'enveloppe. Absente : ancienne trame, sans identité
 * bot/turn/session/bail. Un client tolère toute version et ignore les champs
 * qu'il ne connaît pas.
 */
export const EVENT_ENVELOPE_VERSION = 1;

/**
 * L'enveloppe unique d'un événement produit : la même au push live, au rejeu
 * SSE et dans le hint worker (`POST /internal/events/publish`). Construite par
 * `organizationEventEnvelope` et nulle part ailleurs.
 *
 * - `cursor` : position dans le flux de l'ORGANISATION, allouée au commit sous
 *   le verrou `openedbot-run-events-cursor` ; c'est le curseur de reprise
 *   (`?cursor=` / `Last-Event-ID`), strictement croissant par connexion.
 *   Absent tant que la ligne n'est pas commitée : une trame poussée avant
 *   l'INSERT n'a pas de curseur, et le SSE ne lui met pas de champ `id:`.
 * - `sequence` : position dans le RUN, unique avec `runId` ; un rejeu de la
 *   même `(runId, sequence)` est absorbé (`on conflict do nothing`), y compris
 *   un terminal. C'est la clé d'idempotence avant qu'un curseur existe.
 * - `turnId` : le tour utilisateur. `workflows.root_run_id` pour une étape de
 *   workflow, sinon l'id du run lui-même (voir `runTurnId`).
 * - `sessionKey` : la clé de session Hermes du run (`openedbot:{org}:…`), un
 *   identifiant structurel, jamais un secret.
 * - `leaseGeneration` : le bail sous lequel la ligne a été écrite ; `null` pour
 *   une ligne antérieure à 0092.
 *
 * Les champs d'identité sont optionnels au typage : un client doit lire une
 * trame d'avant la version 1 sans planter.
 */
export type OrganizationEvent<T = Record<string, unknown>> = {
  version?: typeof EVENT_ENVELOPE_VERSION;
  /** Absent avant le commit : le curseur n'existe pas encore. */
  cursor?: number;
  organizationId: string;
  threadId: string | null;
  runId: string;
  botId?: string | null;
  turnId?: string | null;
  sessionKey?: string | null;
  leaseGeneration?: number | null;
  sequence: number;
  type: string;
  payload: T;
  occurredAt: string;
};

/**
 * Une ligne `run_events` telle que la rendent un `returning` ou un `select`
 * (curseur `bigint` en chaîne, horodatage en `Date`).
 */
export type RunEventRecord<T = Record<string, unknown>> = {
  /** Absent : enveloppe live, avant que l'INSERT n'alloue le curseur. */
  cursor?: number | string | bigint | null;
  organizationId: string;
  threadId: string | null;
  runId: string;
  botId: string | null;
  turnId: string | null;
  sessionKey: string | null;
  leaseGeneration: number | string | bigint | null;
  sequence: number;
  type: string;
  payload: T;
  occurredAt: Date | string;
};

/**
 * La seule fabrique d'enveloppe. L'ordre des clés est fixe : une ligne
 * committée sort identique au push post-commit et au rejeu. Sans curseur
 * (avant l'INSERT), `cursor` est omis. `completion` se pose au rejeu seulement.
 */
export function organizationEventEnvelope<T>(record: RunEventRecord<T>): OrganizationEvent<T> {
  const cursor = record.cursor === null || record.cursor === undefined ? null : Number(record.cursor);
  const committed = cursor !== null && Number.isSafeInteger(cursor);
  return {
    version: EVENT_ENVELOPE_VERSION,
    ...(committed ? { cursor } : {}),
    organizationId: record.organizationId,
    threadId: record.threadId,
    runId: record.runId,
    botId: record.botId ?? null,
    turnId: record.turnId ?? null,
    sessionKey: record.sessionKey ?? null,
    leaseGeneration: record.leaseGeneration === null || record.leaseGeneration === undefined
      ? null
      : Number(record.leaseGeneration),
    sequence: Number(record.sequence),
    type: record.type,
    payload: record.payload,
    occurredAt: record.occurredAt instanceof Date
      ? record.occurredAt.toISOString()
      : new Date(record.occurredAt).toISOString(),
  };
}

/**
 * Le tour d'un run, même règle que le trigger `run_events_stamp_identity`
 * (0092) : `coalesce(workflows.root_run_id, runs.id)`. L'id du run racine
 * plutôt que celui du message d'ingress : routines, hand-offs et courriers
 * n'ont pas de message, et un DM sans workflow a pour run racine le
 * run même que réserve `message_ingress.run_id`, donc le tour ne change pas
 * quand le workflow disparaît.
 */
export function runTurnId(run: { runId: string; workflowRootRunId: string | null }): string {
  return run.workflowRootRunId ?? run.runId;
}

export type ProductEventType =
  | "message.admitted"
  | "run.steering"
  | "agent.message"
  | "agent.reasoning"
  | "tool.call"
  | "tool.result"
  /**
   * US-CHAT-07 : le contenu réel d'un résultat, relevé APRÈS le run par
   * `listHermesSessionMessages` ; `tool.result` (ci-dessus) ne fait que
   * marquer un appel comme terminé, sans charge utile (MESURÉ, voir
   * `hermes-events.ts`). Un événement distinct plutôt qu'une réécriture de
   * `tool.result` : `run_events` n'a pas de sémantique de mise à jour, et un
   * client déjà connecté ignore tout événement dont le curseur n'est pas
   * strictement croissant (`applyProductEventToSnapshot`) : une ligne
   * modifiée en place ne lui parviendrait jamais.
   */
  | "tool.result.attached"
  | "approval.requested"
  | "approval.responded"
  | "run.completed"
  | "run.error"
  | "run.provider_fallback"
  | "system.notice"
  /**
   * Bot mode : la réponse d'un autre bot vient d'être déposée dans ce fil
   * (`payload: { messageId, fromBotId, fromSlug, fromName, text, ok }`).
   * Émis par le worker, sur le run « courrier » du fil d'origine. Le
   * message lui-même vit dans `messages` (rôle `user` + `authorBot`) : c'est
   * la ligne qui s'affiche ; cet événement est le signal qui dit au client
   * de relire le fil, et il ne se rend pas.
   */
  | "bot.message"
  | "raw";

/**
 * The `tool.result` payload as the worker writes it (`hermes-events.ts`,
 * `tool.completed`). Every field is optional for a reader: rows written by
 * an older worker lack the newer ones, and a client never infers a value
 * from an absent field.
 *
 * `resultExcerpt` is the runtime's bounded, secret-redacted preview of the
 * tool output (upstream caps it at 500 characters). It arrives live, as the
 * call completes, long before `tool.result.attached` brings the full
 * transcript at the end of the run.
 */
export type ToolResultEventPayload = {
  toolCallId?: string;
  tool?: string;
  durationMs?: number | null;
  error?: boolean;
  errorMessage?: string | null;
  resultExcerpt?: string | null;
  hasResultPayload?: boolean;
  agentPlan?: unknown;
  webSearch?: unknown;
};

export type ProductEventInput = {
  sequence: number;
  type: ProductEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

export type StoredProductEvent = ProductEventInput & {
  cursor: number;
  runId: string;
};
