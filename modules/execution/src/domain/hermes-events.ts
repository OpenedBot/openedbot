/**
 * Normalisation des evenements Hermes : PRD §13.1.
 *
 * Toutes les formes ci-dessous ont ete MESUREES contre le runtime reel
 * (spike Phase 0, fixtures dans spike/fixtures/). Ne pas se fier a la
 * documentation officielle : elle annonce `assistant.delta`, le runtime
 * emet `message.delta`.
 */

import { HERMES_RUN_FAILURE_CODE, HERMES_RUN_INTERRUPTED_CODE, MODEL_UNAVAILABLE_CODE, NO_USABLE_PROVIDER_CODE } from "@openedbot/contracts-errors";
import type { HermesEvent } from "@openedbot/hermes";
import { APPROVAL_CHOICES, type ApprovalChoice } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import { projectAgentPlan } from "./agent-plan";
import { gateDescriptionText, readGateIdentity } from "./gate-identity";
import { projectWebSearches } from "./agent-web-search";
import { projectToolResults } from "./agent-tool-results";
import { isModelUnavailableFailure } from "./provider-failure";
import { sanitizeToolErrorMessage } from "./tool-text";
import { upstreamErrorFlagIsFalsePositive } from "./tool-error-flag";

export { sanitizeToolErrorMessage, TOOL_ERROR_MESSAGE_MAX_CHARS } from "./tool-text";

export type RunEventType =
  | "agent.message"
  | "agent.reasoning"
  | "tool.call"
  | "tool.result"
  | "tool.result.attached"
  | "approval.requested"
  | "approval.responded"
  | "run.error"
  | "run.completed"
  | "run.provider_fallback"
  | "system.notice"
  | "raw";

export type RunEvent = {
  /** Attribue par la Console : le runtime n'emet aucun identifiant. */
  sequence: number;
  type: RunEventType;
  occurredAt: Date;
  payload: Record<string, unknown>;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/**
 * Intervalle de flush des deltas. Mesure : 33,6 deltas/s a 4 caracteres piece.
 * 50 ms : un flush coute un POST et une transaction, environ trois fois plus
 * qu'a 150 ms, en echange d'un retard d'affichage d'au plus ~50 ms par delta
 * (mesure a 150 ms : p50 91 ms, p90 156 ms, pour ~6 ms de transport). Le
 * premier texte part de toute facon sans attendre (`flushFirstDelta`).
 */
export const DELTA_FLUSH_MS = 50;

export const NO_USABLE_PROVIDER_MESSAGE =
  "Aucun fournisseur de modèles authentifié sur le runtime Hermes. Connectez un fournisseur dans Réglages → Modèles.";

export const HERMES_RUN_FAILURE_MESSAGE = "Le runtime Hermes a interrompu le run.";

/**
 * Consignes d'administration serveur émises par Hermes, et la phrase produit
 * qui les remplace.
 *
 * Mesuré le 31-08 dans une bulle de conversation, sur un téléphone :
 * « Provider authentication failed: No inference provider configured. Run
 * 'hermes model' to choose a provider and model, or set an API key
 * (OPENROUTER_API_KEY, …) in ~/.hermes/.env. » Ce texte désigne un shell auquel
 * l'opérateur n'a pas accès et une action qu'openedbot ne fait pas à sa
 * place (frontière de release) ; il nomme aussi des variables d'environnement.
 */
const UPSTREAM_FAILURES: ReadonlyArray<{ match: RegExp; code: string; message: string }> = [
  {
    match: /no inference provider|provider authentication failed|hermes model|\.hermes\/\.env|_API_KEY/i,
    code: NO_USABLE_PROVIDER_CODE,
    message: NO_USABLE_PROVIDER_MESSAGE,
  },
];

export type HermesRunFailure = {
  message: string;
  errorCode: string;
};

/** The upstream failure flag of a `tool.completed`, minus Hermes' `"error": null` false positive. */
export function toolCompletionFailed(ev: Readonly<Record<string, unknown>>): boolean {
  if (typeof ev.error === "string" && ev.error.trim() !== "") return true;
  if (ev.error !== true) return false;
  const tool = typeof ev.tool === "string" ? ev.tool : "";
  const text = typeof ev.result === "string" ? ev.result : typeof ev.preview === "string" ? ev.preview : null;
  return !upstreamErrorFlagIsFalsePositive(tool, text);
}

/**
 * Ce qu'un `tool.completed` porte comme texte, quand il en porte.
 *
 * Hermes envoie `tool`, `duration`, `error` et un `preview` borné à 500
 * caractères quand le callback reçoit un résultat. Le chemin d'admission
 * peut toutefois ne pas fournir de résultat. On garde donc les champs texte
 * historiques et lit le preview sans supposer qu'il existe.
 */
export function readToolCompletionText(ev: Readonly<Record<string, unknown>>): {
  errorMessage: string | null;
  resultExcerpt: string | null;
} {
  const preview = typeof ev.preview === "string" ? ev.preview : null;
  const failed = toolCompletionFailed(ev);
  const previewErrors: unknown[] = [];
  let previewIndicatesError = false;
  if (preview !== null) {
    try {
      const parsed: unknown = JSON.parse(preview);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const result = parsed as { status?: unknown; success?: unknown; error?: unknown; message?: unknown; user_summary?: unknown };
        previewIndicatesError = result.status === "error" || result.success === false;
        if (previewIndicatesError) previewErrors.push(result.user_summary, result.error, result.message);
      }
    } catch {
      // Les previews texte ne sont pas nécessairement du JSON.
    }
  }
  const result = ev.result;
  const resultText = typeof result === "string"
    ? result
    : result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string"
      ? (result as { error: string }).error
      : null;
  // A truncated JSON preview (`{ "results": [ { ..., "error": "http_error" } ] }`)
  // does not parse: its first non-empty `error` string is the reason, not
  // the raw JSON shown as a failure banner.
  const previewErrorString = preview && /^\s*[{[]/.test(preview)
    ? /"error"\s*:\s*"([^"\\]{1,200})"/.exec(preview)?.[1] ?? null
    : null;
  const candidates: unknown[] = failed
    ? [ev.error_message, ev.errorMessage, ev.message, typeof ev.error === "string" ? ev.error : null, resultText,
        ...previewErrors, previewErrorString, previewIndicatesError || previewErrorString ? null : preview]
    : [];
  const errorMessage = (failed ? candidates : previewErrors)
    .map(sanitizeToolErrorMessage).find((text) => text !== null) ?? null;
  const resultExcerpt = sanitizeToolErrorMessage(resultText ?? (previewIndicatesError || failed ? null : preview));
  return { errorMessage, resultExcerpt };
}

/**
 * L'échec d'un run tel qu'il a le droit d'être persisté puis affiché.
 *
 * Le chemin HTTP du client Hermes applique déjà cette règle (`throwResponse`
 * dans platform/hermes) : le texte amont est capturé pour le journal, jamais
 * pour le fil. Le flux SSE n'avait pas le même filtre et recopiait `message`
 * mot pour mot jusque dans `runs.error_message`.
 */
export function hermesRunFailure(raw: Readonly<Record<string, unknown>>): HermesRunFailure {
  const upstream = typeof raw.message === "string" && raw.message.trim()
    ? raw.message.trim()
    : typeof raw.error === "string" && raw.error.trim()
      ? raw.error.trim()
      : "";
  if (!upstream) return { message: HERMES_RUN_FAILURE_MESSAGE, errorCode: HERMES_RUN_FAILURE_CODE };
  const known = UPSTREAM_FAILURES.find((candidate) => candidate.match.test(upstream));
  if (known) return { message: known.message, errorCode: known.code };
  // Le modèle refusé garde le texte d'origine (assaini) : la console s'appuie
  // sur le code, pas sur ces mots, et l'opérateur les lit tels quels.
  if (isModelUnavailableFailure(upstream)) {
    return { message: sanitizeToolErrorMessage(upstream) ?? HERMES_RUN_FAILURE_MESSAGE, errorCode: MODEL_UNAVAILABLE_CODE };
  }
  return { message: sanitizeToolErrorMessage(upstream) ?? HERMES_RUN_FAILURE_MESSAGE, errorCode: HERMES_RUN_FAILURE_CODE };
}

/** Unknown runtime bodies are private diagnostics, not a public payload contract. */
function rawEventMetadata(event: HermesEvent): Record<string, unknown> {
  return { event: typeof event.event === "string" ? event.event.slice(0, 80) : "unknown" };
}

/**
 * Normaliseur a etat. Une instance par mission.
 *
 * Deux differences sont adaptees ici :
 *  1. aucun identifiant d'evenement -> on genere une `sequence` monotone ;
 *  2. l'identifiant d'appel d'outil est facultatif -> on l'utilise quand il
 *     existe, puis on garde le FIFO par nom d'outil comme repli.
 */
export type HermesEventNormalizerOptions = {
  flushFirstDelta?: boolean;
  priorToolCalls?: ReadonlyArray<{ tool: string; toolCallId: string; completed: boolean }>;
};

export class HermesEventNormalizer {
  private sequence: number;
  private emittedText = false;
  private attachedToolResults = false;

  /**
   * `startAt` doit valoir MAX(sequence)+1 quand on reprend une mission qui a
   * deja des evenements persistes (resume au boot, annulation hors process,
   * cloture d'orphelin). Repartir de 0 viole UNIQUE(run_id, sequence) et fait
   * echouer la transition d'etat qui suit.
   */
  constructor(startAt = 0, private readonly options: HermesEventNormalizerOptions = {}) {
    this.sequence = startAt;
    for (const call of options.priorToolCalls ?? []) {
      this.recordToolCall(call.tool, call.toolCallId);
      const counter = /^tc_(?:orphan_)?(\d+)$/.exec(call.toolCallId)?.[1];
      if (counter) this.toolCallCounter = Math.max(this.toolCallCounter, Number(counter) + 1);
      if (!call.completed) {
        const queue = this.openToolCalls.get(call.tool) ?? [];
        queue.push(call.toolCallId);
        this.openToolCalls.set(call.tool, queue);
      }
    }
  }
  /** File FIFO des appels d'outil ouverts, par nom d'outil. */
  private openToolCalls = new Map<string, string[]>();
  /** Tous les identifiants d'appel emis, par outil, pour joindre le transcript final. */
  private toolCallHistory = new Map<string, string[]>();
  private toolCallIdsByUpstream = new Map<string, string>();
  private toolCallCounter = 0;

  /** Tampon de coalescing des deltas. */
  private buffer = "";
  private bufferStartedAt: Date | null = null;

  /**
   * Indique au consommateur qu'un flush temporel doit être armé. Sans cette
   * information, une rafale suivie d'une pause reste invisible jusqu'au
   * prochain événement Hermes (voire jusqu'à `run.completed`).
   */
  get hasBufferedDelta(): boolean {
    return this.buffer.length > 0;
  }

  /** Rattache le transcript sans deviner quand les comptes d'appels divergent. */
  attachToolResults(messages: unknown, occurredAt = new Date()): RunEvent[] {
    if (this.attachedToolResults) return [];
    this.attachedToolResults = true;
    const projected = projectToolResults(messages);

    const projectedCounts = new Map<string, number>();
    for (const entry of projected) projectedCounts.set(entry.tool, (projectedCounts.get(entry.tool) ?? 0) + 1);
    const ambiguousTools = new Set<string>();
    for (const [tool, callIds] of this.toolCallHistory) {
      if ((projectedCounts.get(tool) ?? 0) !== callIds.length) ambiguousTools.add(tool);
    }
    for (const [tool, count] of projectedCounts) {
      if ((this.toolCallHistory.get(tool)?.length ?? 0) !== count) ambiguousTools.add(tool);
    }

    const ordinals = new Map<string, number>();
    const emittedAmbiguous = new Set<string>();
    const events: RunEvent[] = [];
    for (const entry of projected) {
      const ordinal = ordinals.get(entry.tool) ?? 0;
      ordinals.set(entry.tool, ordinal + 1);
      const callIds = this.toolCallHistory.get(entry.tool) ?? [];
      if (ambiguousTools.has(entry.tool)) {
        if (emittedAmbiguous.has(entry.tool)) continue;
        emittedAmbiguous.add(entry.tool);
        for (const toolCallId of callIds) {
          events.push(this.next("tool.result.attached", occurredAt, {
            toolCallId,
            tool: entry.tool,
            ambiguous: true,
          }));
        }
        continue;
      }

      const upstreamId = this.toolCallIdsByUpstream.get(entry.callId);
      const toolCallId = upstreamId && callIds.includes(upstreamId) ? upstreamId : callIds[ordinal];
      if (!toolCallId) continue;
      events.push(this.next("tool.result.attached", occurredAt, {
        toolCallId,
        tool: entry.tool,
        ...(entry.input !== null ? { input: entry.input } : {}),
        ...(entry.result !== null ? { result: entry.result } : {}),
        ...(entry.truncated ? { truncated: true } : {}),
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        ...(entry.exitCode !== null ? { exitCode: entry.exitCode } : {}),
        ...(entry.status ? { status: entry.status } : {}),
      }));
    }

    for (const [tool, callIds] of this.toolCallHistory) {
      if (!ambiguousTools.has(tool) || emittedAmbiguous.has(tool)) continue;
      for (const toolCallId of callIds) {
        events.push(this.next("tool.result.attached", occurredAt, { toolCallId, tool, ambiguous: true }));
      }
    }
    return events;
  }

  private recordToolCall(tool: string, toolCallId: string): void {
    const history = this.toolCallHistory.get(tool) ?? [];
    if (!history.includes(toolCallId)) history.push(toolCallId);
    this.toolCallHistory.set(tool, history);
  }

  /**
   * Another writer persisted an event of this run at `sequence` (the
   * `run.provider_fallback` notice written between two Hermes attempts).
   * The next event emitted here must come after it: the insert is
   * `on conflict do nothing`, so a shared sequence silently drops the event,
   * and after a fallback that was the first delta of the answer.
   */
  skipPast(sequence: number): void {
    this.sequence = Math.max(this.sequence, sequence + 1);
  }

  private next(type: RunEventType, occurredAt: Date, payload: Record<string, unknown>): RunEvent {
    return { sequence: this.sequence++, type, occurredAt, payload };
  }

  private toDate(ts: unknown): Date {
    // Epoch flottant en SECONDES -> millisecondes.
    return typeof ts === "number" ? new Date(ts * 1000) : new Date();
  }

  /** Vide le tampon de deltas en un unique evenement `agent.message`. */
  flush(): RunEvent[] {
    if (!this.buffer) return [];
    const text = this.buffer;
    const at = this.bufferStartedAt ?? new Date();
    this.buffer = "";
    this.bufferStartedAt = null;
    this.emittedText = true;
    return [this.next("agent.message", at, { text })];
  }

  /**
   * Consomme un evenement runtime. Renvoie 0..n evenements produit.
   * Les deltas sont accumules : appeler `flush()` toutes les DELTA_FLUSH_MS.
   */
  push(ev: HermesEvent): RunEvent[] {
    const at = this.toDate(ev.timestamp);

    switch (ev.event) {
      case "message.delta": {
        // Coalescing : persister un delta par ligne est exclu.
        const delta = String(ev.delta ?? "");
        if (!delta) return [];
        this.buffer += delta;
        this.bufferStartedAt ??= at;
        if (this.options.flushFirstDelta && !this.emittedText) return this.flush();
        return [];
      }

      case "tool.started": {
        const tool = String(ev.tool ?? "outil");
        const raw = ev as unknown as Record<string, unknown>;
        const rawId = typeof raw.tool_call_id === "string" ? raw.tool_call_id.trim() : "";
        const upstreamId = rawId.length <= 200 ? rawId : "";
        const existing = upstreamId ? this.toolCallIdsByUpstream.get(upstreamId) : undefined;
        const toolCallId = (existing && (this.toolCallHistory.get(tool)?.includes(existing) ?? false) ? existing : undefined)
          ?? `tc_${this.toolCallCounter++}`;
        if (upstreamId) this.toolCallIdsByUpstream.set(upstreamId, toolCallId);
        const queue = this.openToolCalls.get(tool) ?? [];
        if (!queue.includes(toolCallId)) queue.push(toolCallId);
        this.openToolCalls.set(tool, queue);
        this.recordToolCall(tool, toolCallId);
        // Le texte deja accumule precede l'appel : on le sort d'abord.
        return [
          ...this.flush(),
          this.next("tool.call", at, { toolCallId, tool, preview: sanitizeToolErrorMessage(ev.preview) }),
        ];
      }

      case "tool.completed": {
        const tool = String(ev.tool ?? "outil");
        const queue = this.openToolCalls.get(tool) ?? [];
        const raw = ev as unknown as Record<string, unknown>;
        const rawId = typeof raw.tool_call_id === "string" ? raw.tool_call_id.trim() : "";
        const upstreamId = rawId.length <= 200 ? rawId : "";
        const mapped = upstreamId ? this.toolCallIdsByUpstream.get(upstreamId) : undefined;
        const mappedId = mapped && (this.toolCallHistory.get(tool)?.includes(mapped) ?? false) ? mapped : undefined;
        // L'identifiant amont rend l'appariement exact; le FIFO garde la compatibilite.
        const queueIndex = mappedId ? queue.indexOf(mappedId) : -1;
        const toolCallId = mappedId ?? queue.shift() ?? `tc_orphan_${this.toolCallCounter++}`;
        if (queueIndex >= 0) queue.splice(queueIndex, 1);
        if (upstreamId) this.toolCallIdsByUpstream.set(upstreamId, toolCallId);
        this.openToolCalls.set(tool, queue);
        this.recordToolCall(tool, toolCallId);
        const { errorMessage, resultExcerpt } = readToolCompletionText(ev);
        return [
          // Un runtime peut produire une courte explication avant de clore
          // l'outil. Elle doit rester avant son résultat, même si le flush
          // temporel n'a pas encore sonné.
          ...this.flush(),
          this.next("tool.result", at, {
            toolCallId,
            tool,
            // Hermes 0.23 sends `duration: 0` on the session-authority path, where
            // it no longer times the tool: zero is "not measured", never a real 0 ms.
            durationMs: typeof ev.duration === "number" && ev.duration > 0 ? ev.duration * 1000 : null,
            error: toolCompletionFailed(ev),
            // Les deux champs restent présents même quand le preview amont
            // manque, ce qui distingue « rien reçu » d'une forme de payload.
            errorMessage,
            resultExcerpt,
            // Vrai UNIQUEMENT quand un extrait est réellement là : l'UI ne
            // doit pas laisser croire qu'un détail est repliable.
            hasResultPayload: resultExcerpt !== null,
          }),
        ];
      }

      case "approval.request": {
        // openedbot keys the gate by its own id; Hermes' `request_id` rides in
        // `gate`. Flush first so the id matches the sequence assigned to this
        // approval event even when a buffered assistant delta precedes it.
        // The sequence is monotone and resumed from persisted events, so it
        // is stable within the run.
        const flushed = this.flush();
        const approvalRequestId = `approval_${this.sequence}`;
        return [
          ...flushed,
          this.next("approval.requested", at, {
            approvalRequestId,
            command: sanitizeToolErrorMessage(ev.command),
            choices: Array.isArray(ev.choices)
              ? ev.choices.filter((choice) => typeof choice === "string" && APPROVAL_CHOICES.includes(choice as ApprovalChoice))
              : [],
            description: sanitizeToolErrorMessage(gateDescriptionText(ev.description)),
            // PERM2-A: read on the raw event, before any display masking.
            // A vehicle for `approval_requests`, never a `run_events` body.
            gate: readGateIdentity(ev as unknown as Record<string, unknown>),
          }),
        ];
      }

      // MESURE : le runtime confirme la decision par `approval.responded`
      // { choice, resolved }. Il tombait dans le fourre-tout `raw`, donc
      // invisible : alors que c'est la seule trace de qui a autorise quoi.
      case "approval.responded": {
        const choice = typeof ev.choice === "string" ? ev.choice : null;
        // Un choix hors vocabulaire n'est pas une decision qu'on sait raconter :
        // on le laisse en brut plutot que d'inventer un libelle.
        if (!choice || !APPROVAL_CHOICES.includes(choice as ApprovalChoice)) {
          return [...this.flush(), this.next("raw", at, rawEventMetadata(ev))];
        }
        return [
          ...this.flush(),
          this.next("approval.responded", at, {
            choice,
            resolved: typeof ev.resolved === "number" ? ev.resolved : null,
          }),
        ];
      }

      case "run.completed": {
        const usage = (ev.usage ?? null) as Record<string, number> | null;
        // `messages` est le transcript AUTORITATIF DU TOUR, borné par l'amont
        // (`_turn_transcript_messages`, gateway/platforms/api_server_openai_routes.py).
        // Plan et recherches s'y lisent sans relire la session entière, donc
        // sans risquer d'y ramasser le tour précédent.
        const agentPlan = projectAgentPlan(ev.messages);
        const webSearch = projectWebSearches(ev.messages);
        return [
          ...this.flush(),
          this.next("run.completed", at, {
            output: ev.output ?? null,
            ...(agentPlan ? { agentPlan } : {}),
            ...(webSearch ? { webSearch } : {}),
            usage: usage
              ? ({
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  totalTokens: usage.total_tokens ?? 0,
                } satisfies TokenUsage)
              : null,
          }),
        ];
      }

      case "run.failed":
      case "run.error": {
        return [
          ...this.flush(),
          this.next("run.error", at, { ...hermesRunFailure(ev) }),
        ];
      }

      case "run.interrupted": {
        return [
          ...this.flush(),
          this.next("run.error", at, {
            message: "Le gateway Hermes a interrompu le run, probablement lors d’un redémarrage.",
            errorCode: HERMES_RUN_INTERRUPTED_CODE,
          }),
        ];
      }

      case "message.interim":
        return [];

      case "run.cancelled": {
        return [
          ...this.flush(),
          this.next("system.notice", at, {
            message: "Mission annulée.",
            kind: "cancelled",
          }),
        ];
      }

      // MESURE : malgre son nom, `reasoning.available` ne contient pas de
      // raisonnement mais le TEXTE FINAL COMPLET, doublon de
      // run.completed.output. Le rendre afficherait la reponse deux fois.
      case "reasoning.available":
        return [];

      default:
        // Keep the event marker without publishing an unknown private body.
        return [...this.flush(), this.next("raw", at, rawEventMetadata(ev))];
    }
  }

  notice(message: string, kind: string): RunEvent {
    return this.next("system.notice", new Date(), { message, kind });
  }

  error(message: string): RunEvent {
    return this.next("run.error", new Date(), { message });
  }
}
