/**
 * Lecture des appels d'outils d'un fil : la couche PURE, partagée par la PWA.
 *
 * Née dans un client natif puis remontée
 * ici : les clients répondent aux mêmes questions (« cet appel est-il
 * terminé ? », « comment replier onze `terminal` d'affilée ? ») et deux
 * copies de la réponse avaient déjà divergé : l'écran empilait les chips que
 * l'autre savait replier.
 */
import type { StoredProductEvent, ToolResultEventPayload } from "@openedbot/contracts-events";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import type { Locale } from "@openedbot/contracts-locale";
import { t } from "@openedbot/contracts-i18n";
import { fr } from "@openedbot/contracts-i18n/messages.fr";
import { SUPERSEDED_NOTICE_KIND } from "./followup";

/**
 * Ce qu'un `tool.result.attached` rattache à un appel, ou l'aveu qu'il n'a
 * pas su à quel appel il revenait (US-CHAT-07).
 *
 * `ambiguous` et `result` s'EXCLUENT, et c'est le point : le cloud API
 * préfère dire « je ne sais pas » plutôt que d'attribuer un résultat au
 * mauvais appel. Un type qui autoriserait les deux à la fois rouvrirait à
 * l'écran la porte que le cloud API a fermée.
 */
export type ToolAttachment = { ambiguous: true } | {
  input?: string;
  result?: string;
  errorMessage?: string;
  exitCode?: number;
  status?: string;
  truncated?: true;
};

/**
 * Un appel d'outil, s'il a rendu, et ce qu'on sait de son exécution.
 *
 * `failed`, `durationMs` et `preview` sont OPTIONNELS et absents quand la
 * source ne les porte pas : le client natif ne les pose pas encore, et un champ
 * toujours présent aurait changé la forme de ses groupes sous ses tests.
 */
export type ToolCall = {
  tool: string;
  done: boolean;
  /** `tool.result.error` : l'appel a rendu, mais en échec. */
  failed?: boolean;
  /** `tool.result.durationMs` : millisecondes, quand le runtime les donne. */
  durationMs?: number;
  /** `tool.result.errorMessage` : le pourquoi de l'échec, quand le runtime le dit. */
  errorMessage?: string;
  /** `tool.call.preview` : l'extrait de commande/requête émis par le runtime. */
  preview?: string;
  /**
   * `tool.result.resultExcerpt`: the bounded output preview the runtime sends
   * as the call completes. The full result only arrives with the end of the
   * run (`attachment`); the excerpt is what the thread can show live.
   */
  resultExcerpt?: string;
  attachment?: ToolAttachment;
};

/** Des appels consécutifs de MÊME outil, comptés : voir `groupToolCalls`. */
export type ToolGroup = {
  tool: string;
  count: number;
  done: boolean;
  /** Les appels individuels, même quand la rangée les replie. */
  calls: ToolCall[];
  /** Vrai dès qu'UN appel du groupe a échoué. */
  failed?: boolean;
  /**
   * Nombre d'appels du groupe en échec : présent dès qu'il y en a un. Avec
   * `count`, il dit « 1 échec sur 2 » là où `failed` seul peindrait les deux
   * appels en rouge.
   */
  failures?: number;
  /** Les messages d'erreur connus des appels en échec, dans l'ordre ; absent sans message. */
  errorMessages?: string[];
  /** Somme des durées connues du groupe. */
  durationMs?: number;
  /** Extrait du seul appel : absent dès que `count > 1` (voir `previews`). */
  preview?: string;
  /**
   * Les extraits de chaque appel, dans l'ordre. Pour `skill_view`, c'est le
   * nom de la skill (`build_tool_preview` amont). Présent dès qu'au moins
   * un appel en a un, y compris après un repli `×N`.
   */
  previews?: string[];
  /** Toujours absent dès que `count > 1` : un résultat appartient à UN appel. */
  attachment?: ToolAttachment;
};

/**
 * Les appels consécutifs de même nom, repliés en un seul avec leur compte.
 *
 * Consécutifs, et pas globaux : `terminal ×3 · read_file · terminal ×2` est ce
 * qui s'est réellement passé. Compter par nom sur tout le tour rendrait
 * `terminal ×5 · read_file`, qui décrit une autre histoire : l'ordre porte
 * l'information ici, un agent qui relit un fichier ENTRE deux commandes ne fait
 * pas la même chose que celui qui le relit après.
 *
 * Un groupe n'est « terminé » que si tous ses appels le sont : c'est le
 * dernier qui décide, et l'afficher terminé pendant qu'il tourne encore serait
 * le seul mensonge que ce repli pourrait produire. Il est « en échec » dès
 * qu'un appel l'est : un `terminal ×7` dont le troisième a cassé ne se lit
 * pas comme sept succès.
 *
 * Un groupe garde ses appels individuels dans `calls` : le détail pourra donc
 * montrer chaque entrée et chaque sortie sans prétendre qu'elles sont communes.
 * Le champ `preview` tombe au repli ; `previews` accumule chaque extrait pour
 * que la rangée reste lisible. Les durées, elles, s'ADDITIONNENT.
 */
export function groupToolCalls(calls: readonly ToolCall[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const sourceCall of calls) {
    const attachmentError = sourceCall.attachment && !("ambiguous" in sourceCall.attachment)
      ? sourceCall.attachment.errorMessage
      : undefined;
    const call = sourceCall.errorMessage || !attachmentError
      ? sourceCall
      : { ...sourceCall, errorMessage: attachmentError };
    const last = groups[groups.length - 1];
    if (last && last.tool === call.tool) {
      last.count += 1;
      last.calls.push(call);
      last.done = last.done && call.done;
      if (call.failed) {
        last.failed = true;
        last.failures = (last.failures ?? 0) + 1;
      }
      if (call.errorMessage) last.errorMessages = [...(last.errorMessages ?? []), call.errorMessage];
      if (typeof call.durationMs === "number") {
        last.durationMs = (last.durationMs ?? 0) + call.durationMs;
      }
      if (call.preview) last.previews = [...(last.previews ?? []), call.preview];
      if (last.preview !== undefined) delete last.preview;
      if (last.attachment !== undefined) delete last.attachment;
      continue;
    }
    groups.push({
      tool: call.tool,
      count: 1,
      done: call.done,
      calls: [call],
      ...(call.failed ? { failed: true as const, failures: 1 } : {}),
      ...(call.errorMessage ? { errorMessages: [call.errorMessage] } : {}),
      ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
      ...(call.preview !== undefined && call.preview !== ""
        ? { preview: call.preview, previews: [call.preview] }
        : {}),
      ...(call.attachment ? { attachment: call.attachment } : {}),
    });
  }
  return groups;
}

/**
 * Le contenu d'un `tool.result.attached`, ou `null` quand il n'en porte pas.
 *
 * Un `result` non textuel est traité comme absent plutôt que rendu tel quel :
 * `[object Object]` sous un chip d'outil ne renseigne personne et se lit comme
 * un bug de l'application, pas comme une sortie de commande.
 *
 * Un résultat vide reste absent : Hermes en produit quand l'adaptateur reçoit
 * un contenu non textuel (`hermes-adapter.ts`). Les autres champs peuvent
 * quand même rendre l'attachement utile, par exemple une entrée sans sortie.
 */
export function readAttachment(payload: Record<string, unknown>): ToolAttachment | null {
  if (payload.ambiguous === true) return { ambiguous: true };
  const attachment: Exclude<ToolAttachment, { ambiguous: true }> = {};
  if (typeof payload.input === "string" && payload.input !== "") attachment.input = payload.input;
  if (typeof payload.result === "string" && payload.result !== "") attachment.result = payload.result;
  if (typeof payload.errorMessage === "string" && payload.errorMessage !== "") attachment.errorMessage = payload.errorMessage;
  if (typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode)) attachment.exitCode = payload.exitCode;
  if (typeof payload.status === "string" && payload.status !== "") attachment.status = payload.status;
  if (payload.truncated === true) attachment.truncated = true;
  return Object.keys(attachment).length > 0 ? attachment : null;
}

/** `toolCallId` seul se répète d'un run à l'autre (compteur remis à zéro par run côté cloud API) : la clé doit toujours porter `runId`. */
export function toolCallKey(event: Pick<StoredProductEvent, "runId" | "payload">): string {
  return `${event.runId}\0${String(event.payload.toolCallId)}`;
}

/**
 * Ce qu'un `tool.result` dit de l'exécution : l'issue, et la durée quand le
 * runtime la donne (`hermes-events.ts` la convertit en millisecondes).
 *
 * La PRÉSENCE d'une entrée vaut « terminé » : c'est le `tool.result` lui-même
 * qui le prouve. Un booléen `done` de plus ici en ferait deux sources pour un
 * seul fait, dont l'une pourrait mentir.
 */
export type ToolOutcome = {
  failed: boolean;
  durationMs: number | null;
  /** `tool.result.errorMessage` : `null` tant que le runtime n'en transmet pas (mesuré : jamais sur `/v1/runs`). */
  errorMessage: string | null;
  /** `tool.result.resultExcerpt`, absent when the runtime sent no preview. */
  resultExcerpt?: string;
};

/**
 * `failed` dans un groupe compté : « 1 échec sur 2 » quand une partie a
 * réussi, et l'échec franc seulement quand TOUT a échoué. Un `terminal ×2`
 * dont un appel a abouti peint en rouge un travail à moitié fait.
 */
export type ToolGroupStatus = "running" | "done" | "failed" | "partial";

/** Les extraits à montrer pour un groupe, dans l'ordre des appels. */
export function toolGroupPreviews(group: Pick<ToolGroup, "preview" | "previews">): string[] {
  if (group.previews && group.previews.length > 0) return group.previews;
  if (group.preview) return [group.preview];
  return [];
}

export function toolGroupStatus(group: Pick<ToolGroup, "count" | "done" | "failed" | "failures">): ToolGroupStatus {
  const failures = group.failures ?? (group.failed ? group.count : 0);
  if (failures > 0 && failures < group.count) return "partial";
  if (failures > 0) return "failed";
  return group.done ? "done" : "running";
}

export type RunToolTerminalState = "completed" | "interrupted";

/**
 * A terminal run closes every tool call that did not receive a `tool.result`.
 * Cancellation commonly aborts the command before Hermes can emit that result;
 * leaving the call open would show an infinite spinner below “Run cancelled”.
 */
export function runToolTerminalStates(
  events: readonly StoredProductEvent[],
): Map<string, RunToolTerminalState> {
  const states = new Map<string, RunToolTerminalState>();
  for (const event of events) {
    const interrupted =
      event.type === "run.error" ||
      (event.type === "system.notice" && (event.payload.kind === "cancelled" || event.payload.kind === SUPERSEDED_NOTICE_KIND));
    if (interrupted) {
      states.set(event.runId, "interrupted");
    } else if (event.type === "run.completed" && !states.has(event.runId)) {
      states.set(event.runId, "completed");
    }
  }
  return states;
}

/**
 * L'issue d'un appel, lue sur le payload d'un `tool.result`.
 *
 * `error` et `durationMs` sont émis depuis toujours (`hermes-events.ts`) et
 * n'étaient lus par aucun client : un `terminal` qui a cassé portait le même
 * ✓ vert qu'un succès, sur les deux plateformes.
 */
export function readToolOutcome(payload: Record<string, unknown>): ToolOutcome {
  const result: ToolResultEventPayload = payload;
  const excerpt = typeof result.resultExcerpt === "string" && result.resultExcerpt.trim() !== ""
    ? result.resultExcerpt
    : null;
  return {
    failed: result.error === true,
    durationMs: typeof result.durationMs === "number" ? result.durationMs : null,
    errorMessage: typeof result.errorMessage === "string" && result.errorMessage !== "" ? result.errorMessage : null,
    ...(excerpt !== null ? { resultExcerpt: excerpt } : {}),
  };
}

/** Résumé affichable d'un échec : première ligne, limitée pour tenir dans la rangée. */
export function toolFailureSummary(group: Pick<ToolGroup, "errorMessages">): string | null {
  const first = group.errorMessages?.find((message) => message.trim() !== "")?.split(/\r?\n/, 1)[0]?.trim();
  if (!first) return null;
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

export type ParsedToolResult = {
  status?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  durationSeconds?: number;
  toolCallsMade?: number;
  webResults?: Array<{ url: string; title?: string; error?: string }>;
};

/** Langage du bloc d'entrée, déterminé par l'outil et, pour les fichiers, leur chemin. */
export function toolInputLanguage(tool: string, input?: string): string {
  const bare = tool.replace(/^mcp__.+?__/, "");
  if (bare === "execute_code") return "python";
  if (bare === "terminal" || bare === "shell") return "bash";
  if (bare === "write_file" || bare === "patch") {
    let path = input?.split("\n", 1)[0]?.replace(/^path:\s*/i, "") ?? "";
    try {
      const value: unknown = JSON.parse(input ?? "");
      if (value && typeof value === "object" && "path" in value && typeof value.path === "string") path = value.path;
    } catch {
      // L'entrée peut déjà être présentée comme « chemin puis contenu ».
    }
    const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
    const languages: Record<string, string> = {
      bash: "bash", c: "c", css: "css", go: "go", html: "html", java: "java",
      js: "javascript", jsx: "jsx", json: "json", md: "markdown", mjs: "javascript",
      py: "python", rs: "rust", sql: "sql", sh: "bash", ts: "typescript", tsx: "tsx", yaml: "yaml", yml: "yaml",
    };
    return extension ? languages[extension] ?? "text" : "text";
  }
  if (!input) return "json";
  try {
    JSON.parse(input);
    return "json";
  } catch {
    return "text";
  }
}

/** Lecture tolérante des résultats structurés renvoyés par Hermes. */
export function parseToolResult(tool: string, result: string): ParsedToolResult | null {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return null;
  }
  const record = (candidate: unknown): Record<string, unknown> | null =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null;
  const text = (candidate: unknown): string | undefined =>
    typeof candidate === "string" ? candidate : candidate === null || candidate === undefined ? undefined : String(candidate);
  const object = record(value);
  if (tool.replace(/^mcp__.+?__/, "") === "web_extract") {
    const list = Array.isArray(value) ? value : Array.isArray(object?.results) ? object.results : [];
    const webResults = list.flatMap((item) => {
      const row = record(item);
      if (!row || typeof row.url !== "string") return [];
      return [{
        url: row.url,
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        ...(typeof row.error === "string" ? { error: row.error } : {}),
      }];
    });
    return webResults.length > 0 ? { webResults } : null;
  }
  if (!object) return null;
  const exitCode = typeof object.exit_code === "number" ? object.exit_code
    : typeof object.exitCode === "number" ? object.exitCode : undefined;
  const durationSeconds = typeof object.duration_seconds === "number" ? object.duration_seconds : undefined;
  const toolCallsMade = typeof object.tool_calls_made === "number" ? object.tool_calls_made : undefined;
  const parsed: ParsedToolResult = {
    ...(typeof object.status === "string" ? { status: object.status } : {}),
    ...(text(object.output) !== undefined ? { output: text(object.output) } : {}),
    ...(text(object.error) !== undefined ? { error: text(object.error) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(toolCallsMade !== undefined ? { toolCallsMade } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/** Durée totale des décisions terminées accolées à cette entrée d'outil. */
export function approvalWaitMs(entry: {
  approvals: readonly Pick<ApprovalRequestDto, "requestedAt" | "respondedAt">[];
}): number | null {
  let total = 0;
  let found = false;
  for (const approval of entry.approvals) {
    if (!approval.respondedAt) continue;
    const start = Date.parse(approval.requestedAt);
    const end = Date.parse(approval.respondedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start;
    found = true;
  }
  return found ? total : null;
}

/**
 * `145 ms` sous la seconde, `2,4 s` au-dessus : l'unité suit la locale par le
 * `formatNumber` qu'on lui passe (le séparateur décimal n'est pas le même en
 * français et en anglais).
 *
 * Le formateur est un PARAMÈTRE et non un import : ce module est pur, il ne
 * connaît pas le contexte i18n de l'écran qui l'appelle.
 */
export function formatToolDuration(
  ms: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${formatNumber(ms / 1000, { maximumFractionDigits: 1 })} s`;
}

type ToolLabelKey = keyof typeof fr.toolLabels & string;

function isKnownTool(name: string): name is ToolLabelKey {
  return Object.prototype.hasOwnProperty.call(fr.toolLabels, name);
}

/**
 * Le libellé humain d'un outil (« Exécute une commande »), ou `null` quand le
 * nom n'est pas dans la table : l'appelant montre alors le nom technique nu,
 * jamais une devinette. Le préfixe MCP (`mcp__serveur__outil`) tombe avant la
 * consultation : c'est de l'adressage, pas un nom d'outil différent.
 */
export function toolLabel(locale: Locale, tool: string): string | null {
  const bare = tool.replace(/^mcp__.+?__/, "");
  return isKnownTool(bare) ? t(locale, `toolLabels.${bare}`) : null;
}

/**
 * What a tool does, in the words the thread uses to tell it: a family, not a
 * name. The activity feed picks its glyph from it, the live status line its
 * verb, and the folded summary its count ("3 commands, 1 file read"). An
 * unknown tool is `other`: the thread then shows its technical name, never a
 * guess. The MCP prefix is addressing, not a family of its own, except that
 * an unknown MCP tool still says in which service it ran.
 */
export type ToolKind = "search" | "web" | "read" | "edit" | "run" | "code" | "delegate" | "mcp" | "other";

const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  web_search: "search",
  search: "search",
  web_extract: "web",
  http: "web",
  read_file: "read",
  cat: "read",
  search_files: "read",
  skill_view: "read",
  skills_list: "read",
  write_file: "edit",
  patch: "edit",
  edit_file: "edit",
  terminal: "run",
  shell: "run",
  execute_code: "code",
  delegate_task: "delegate",
  async_delegation: "delegate",
  subagent: "delegate",
};

export function toolKind(tool: string): ToolKind {
  const bare = tool.replace(/^mcp__.+?__/, "");
  if (Object.prototype.hasOwnProperty.call(TOOL_KINDS, bare)) return TOOL_KINDS[bare]!;
  if (bare.startsWith("browser_")) return "web";
  return tool.startsWith("mcp__") ? "mcp" : "other";
}

/** `mcp__notion__search` gives `notion`: the service a tool ran in, or `null`. */
export function toolService(tool: string): string | null {
  const match = /^mcp__(.+?)__/.exec(tool);
  return match?.[1] ?? null;
}

/**
 * One line of a tool's log, as the Tool Result panel paints it: the command
 * that was sent, what came back, an error, or a separator.
 */
export type ToolLogLine = {
  text: string;
  tone: "command" | "output" | "error" | "note";
  /** Only on the marker that stands for the lines cut from the middle: how many. */
  hidden?: number;
};

/**
 * A log stays readable in a small panel, and its node count bounded (OHB-88):
 * past this many lines the middle is cut, the head and the tail kept, one
 * line of the budget saying how many were hidden. The copy and the detail
 * dialog keep the whole text.
 */
export const TOOL_LOG_MAX_LINES = 400;
/** Lines kept before the marker; the tail (where errors are) gets the rest. */
const TOOL_LOG_HEAD_LINES = Math.floor((TOOL_LOG_MAX_LINES - 1) / 2);

type CallOutput = { text: string; tone: "output" | "error"; truncated: boolean };

/**
 * The `output` string of a JSON result that was cut before it closed, decoded
 * up to the cut, or `null` when the text is not such a result.
 *
 * The live excerpt of `tool.result` is bounded by the worker (500 characters,
 * `sanitizeToolErrorMessage`, which ends a cut text with "…"), and a Hermes
 * shell result is JSON whose `output` comes first (`{"output": "...",
 * "exit_code": 0}`). Any real-sized output therefore arrives as JSON that no
 * longer parses. Reading the string escapes up to the cut gives the operator
 * the lines that did arrive instead of one raw line full of `\n`.
 */
function readCutOutput(source: string): { text: string; complete: boolean } | null {
  const opening = /^\{\s*"output"\s*:\s*"/.exec(source);
  if (!opening) return null;
  // The worker's cut marker is the raw "…": Hermes' JSON escapes non-ASCII
  // (`ensure_ascii`), so a raw one at the very end is never part of the output.
  const body = source.endsWith("\u2026") ? source.slice(0, -1) : source;
  const escapes: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
  let text = "";
  for (let index = opening[0].length; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '"') return { text, complete: true };
    if (char !== "\\") {
      text += char;
      continue;
    }
    const next = body[index + 1];
    // An escape cut in its middle ends the readable text.
    if (next === undefined) break;
    if (next === "u") {
      const hex = body.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const decoded = escapes[next];
    if (decoded === undefined) return null;
    text += decoded;
    index += 1;
  }
  return { text, complete: false };
}

function callOutput(call: ToolCall): CallOutput | null {
  const attachment = call.attachment && !("ambiguous" in call.attachment) ? call.attachment : null;
  const source = attachment?.result ?? call.resultExcerpt ?? null;
  if (source === null) return null;
  const parsed = parseToolResult(call.tool, source);
  if (parsed?.webResults) {
    return { text: parsed.webResults.map((row) => row.title ? `${row.title} (${row.url})` : row.url).join("\n"), tone: "output", truncated: false };
  }
  if (parsed?.output !== undefined) {
    if (parsed.output !== "") return { text: parsed.output, tone: "output", truncated: false };
    // `{"output": "", "exit_code": 1, "error": "..."}`: the error is the result.
    if (parsed.error !== undefined && parsed.error.trim() !== "") return { text: parsed.error, tone: "error", truncated: false };
    return null;
  }
  if (parsed === null) {
    const cut = readCutOutput(source);
    if (cut) return { text: cut.text, tone: "output", truncated: !cut.complete };
  }
  return { text: source, tone: "output", truncated: false };
}

/**
 * The log of a group, call after call, in the order the runtime ran them:
 * the command (`tool.call.preview`), then its output (the attached result
 * once the run has ended, the live excerpt before that), then its error.
 * A group of seven `terminal` calls therefore grows as each call starts and
 * returns: Hermes never streams a tool's own stdout (`tool.started` and
 * `tool.completed` only, `gateway/platforms/api_server_runs.py`), so this is
 * the only honest live log the thread can show.
 *
 * Lines are split on newlines; nothing is invented for a call the runtime
 * said nothing about. Past `TOOL_LOG_MAX_LINES` the middle is cut: the head
 * shows what started, the tail what ended (and usually the error), and a
 * marker line between them says how many lines it stands for.
 */
export function toolGroupLog(group: Pick<ToolGroup, "tool" | "calls">, locale: Locale): ToolLogLine[] {
  const lines = fullToolGroupLog(group, locale);
  if (lines.length <= TOOL_LOG_MAX_LINES) return lines;
  const tail = TOOL_LOG_MAX_LINES - 1 - TOOL_LOG_HEAD_LINES;
  const hidden = lines.length - TOOL_LOG_HEAD_LINES - tail;
  const marker: ToolLogLine = {
    text: t(locale, hidden === 1 ? "threadTimeline.toolLogHidden_one" : "threadTimeline.toolLogHidden_other", {
      count: new Intl.NumberFormat(locale).format(hidden),
    }),
    tone: "note",
    hidden,
  };
  return [...lines.slice(0, TOOL_LOG_HEAD_LINES), marker, ...lines.slice(lines.length - tail)];
}

/** Whether a panel's log is an excerpt: its middle was cut by the line budget. */
export function isToolLogCut(lines: readonly ToolLogLine[]): boolean {
  return lines.some((line) => line.hidden !== undefined);
}

/** Every line of the group's log, uncut. */
function fullToolGroupLog(group: Pick<ToolGroup, "tool" | "calls">, locale: Locale): ToolLogLine[] {
  const lines: ToolLogLine[] = [];
  const push = (text: string, tone: ToolLogLine["tone"]) => {
    for (const line of text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")) lines.push({ text: line, tone });
  };
  const shell = toolKind(group.tool) === "run";
  for (const call of group.calls) {
    const start = lines.length;
    if (start > 0 && lines[start - 1]!.text !== "") push("", "note");
    const opened = lines.length;
    if (call.preview) push(shell ? `$ ${call.preview}` : call.preview, "command");
    const output = callOutput(call);
    if (output !== null && output.text.trim() !== "") push(output.text, output.tone);
    if (output?.truncated) push(t(locale, "threadTimeline.resultTruncated"), "note");
    const attachment = call.attachment && !("ambiguous" in call.attachment) ? call.attachment : null;
    const error = call.errorMessage ?? attachment?.errorMessage ?? null;
    if (error && !(output?.text ?? "").includes(error)) push(error, "error");
    // Nothing said about this call: drop the separator it would have opened.
    if (lines.length === opened && opened > start) lines.pop();
  }
  return lines;
}

/**
 * The text "Copy result" puts on the clipboard: every line of the log, joined,
 * the ones the panel's budget hid included. It is what the thread already
 * holds; nothing is fetched for it.
 */
export function toolGroupLogText(group: Pick<ToolGroup, "tool" | "calls">, locale: Locale): string {
  return fullToolGroupLog(group, locale).map((line) => line.text).join("\n");
}
