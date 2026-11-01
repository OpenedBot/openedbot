import { asRecord } from "@openedbot/contracts-primitives";

/**
 * Ce que le modèle a REÇU pendant un tour, et rien d'autre.
 *
 * Trois grandeurs se confondent facilement, et deux d'entre elles mentent :
 *
 *  1. la taille de la SESSION Hermes. Elle grossit indéfiniment, mais elle
 *     n'est pas ce qu'on envoie : openedbot borne l'historique de chaque tour
 *     (`thread-compaction.ts`). Mesuré le 2026-09-11 sur neuf tours d'un bot
 *     jetable : la session est passée de 22 000 à 198 000 jetons pendant que
 *     l'entrée facturée restait plate à 29 300. Une jauge assise sur la
 *     session annonçait 40 % de fenêtre occupée pour un contexte réel de 6 %.
 *
 *  2. l'`usage` du run. C'est un COÛT : un tour qui enchaîne dix appels
 *     d'outils paie dix prompts, chacun portant tout le contexte. Il dépasse
 *     la fenêtre sans que rien ne déborde.
 *
 *  3. ce qui est réellement en main : les instructions, l'historique envoyé,
 *     l'entrée du tour, puis ce que le tour a lui-même ajouté (appels d'outils
 *     et leurs résultats). C'est cela qu'on mesure ici, et c'est cela que le
 *     seuil de compression de l'amont regarde.
 *
 * Le comptage suit l'amont : quatre caractères par jeton
 * (`_CHARS_PER_TOKEN = 4`, `agent/context_compressor.py`). Il ne connaît pas
 * le préambule que le gateway ajoute lui-même (prompt système, outils,
 * skills) : celui-là est mesuré sur l'hôte (`/hermes-setup/model-context`,
 * champ `preamble`), et la lecture d'ici reste un PLANCHER sans lui.
 */

/** Le ratio de l'amont, repris tel quel : jamais une estimation maison. */
export const CHARS_PER_TOKEN = 4;

/** Au-delà, les outils les plus légers du tour ne sont plus nommés. */
export const MAX_CONTEXT_TOOLS = 24;
const MAX_TOOL_NAME = 64;

/**
 * Ce que le tour avait en main, poste par poste. Chaque poste est mesuré sur
 * sa propre source, jamais déduit d'un total : la somme peut dépasser `tokens`
 * de quelques unités (un arrondi par poste), jamais le contredire.
 */
export type ContextUsageBreakdown = {
  /** Les instructions qu'openedbot pose sur le run (`runCreateArgs.instructions`). */
  instructions: number;
  /** L'historique borné qu'openedbot renvoie au tour. */
  history: number;
  /** Le message de l'utilisateur pour ce tour. */
  input: number;
  /** Les appels d'outils émis par le modèle pendant le tour (arguments compris). */
  toolCalls: number;
  /** Ce que ces outils ont rendu. */
  toolResults: number;
  /** Le raisonnement que l'amont garde dans le transcript. */
  reasoning: number;
  /** Le texte des réponses du modèle. */
  reply: number;
};

/** Un outil du tour : ses appels et ses résultats, réunis sous son nom. */
export type ContextUsageTool = {
  name: string;
  tokens: number;
  calls: number;
};

export type ContextUsageReading = {
  /** Le contexte en main à la fin du tour, en jetons estimés. */
  tokens: number;
  /** La part venue des appels d'outils et de leurs résultats, dans ce tour. */
  toolTokens: number;
  /** Ce qui avait été envoyé à l'ouverture du tour, avant tout outil. */
  sentTokens: number;
  /**
   * Le détail par poste. Absent des lectures posées avant lui : le client
   * retombe alors sur `sentTokens` et `toolTokens`.
   */
  breakdown?: ContextUsageBreakdown;
  /** Les outils du tour, du plus lourd au plus léger, bornés à `MAX_CONTEXT_TOOLS`. */
  tools?: ContextUsageTool[];
  /** Toujours estimé : aucun runtime mesuré ne compte les jetons pour nous. */
  source: "estimated";
};

/** Le poids d'une valeur en caractères, sérialisée quand ce n'est pas du texte. */
function charsOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Le poids d'un message de transcript : contenu, appels d'outils, raisonnement. */
function messageChars(value: unknown): number {
  const message = asRecord(value);
  if (!message) return 0;
  return charsOf(message.content) + charsOf(message.tool_calls)
    + charsOf(message.reasoning) + charsOf(message.reasoning_content);
}

function toTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Un nom d'outil affichable, ou `null` : jamais une chaîne arbitraire de l'amont. */
function toolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name ? name.slice(0, MAX_TOOL_NAME) : null;
}

/** Le nom d'un appel au format OpenAI (`{ function: { name } }`), ou à plat. */
function callName(call: Record<string, unknown>): string | null {
  return toolName(asRecord(call.function)?.name) ?? toolName(call.name);
}

/**
 * La lecture d'un tour. `null` quand il n'y a rien à mesurer : un tour sans
 * entrée ni historique ne se lit pas « contexte à zéro », il ne se lit pas.
 *
 * `turnMessages` est le transcript du tour, celui que l'amont livre avec
 * `run.completed` : il porte les appels d'outils et leurs résultats, donc la
 * croissance interne au tour.
 */
export function readContextUsage(input: {
  instructions?: string | null;
  history?: readonly unknown[] | null;
  input?: string | null;
  turnMessages?: unknown;
}): ContextUsageReading | null {
  const chars = {
    instructions: charsOf(input.instructions),
    history: 0,
    input: charsOf(input.input),
    toolCalls: 0,
    toolResults: 0,
    reasoning: 0,
    reply: 0,
  };
  for (const message of input.history ?? []) chars.history += messageChars(message);
  const sentChars = chars.instructions + chars.history + chars.input;

  let turnChars = 0;
  let toolChars = 0;
  // Un résultat d'outil ne porte pas toujours le nom de l'outil : il renvoie à
  // l'appel par `tool_call_id`, et c'est l'appel qui le nomme.
  const callNames = new Map<string, string>();
  const tools = new Map<string, { chars: number; calls: number }>();
  const addTool = (name: string, weight: number, call: boolean) => {
    const entry = tools.get(name) ?? { chars: 0, calls: 0 };
    entry.chars += weight;
    if (call) entry.calls += 1;
    tools.set(name, entry);
  };
  if (Array.isArray(input.turnMessages)) {
    for (const entry of input.turnMessages) {
      const message = asRecord(entry);
      if (!message) continue;
      const weight = messageChars(entry);
      turnChars += weight;
      if (message.role === "tool" || Array.isArray(message.tool_calls)) toolChars += weight;

      chars.reasoning += charsOf(message.reasoning) + charsOf(message.reasoning_content);
      if (message.role === "tool") {
        const content = charsOf(message.content);
        chars.toolResults += content;
        const id = typeof message.tool_call_id === "string" ? message.tool_call_id : null;
        const name = (id ? callNames.get(id) : undefined) ?? toolName(message.name);
        if (name) addTool(name, content, false);
        continue;
      }
      // Le message de l'utilisateur, quand l'amont le répète dans le tour, est
      // une entrée ; tout le reste est ce que le modèle a écrit.
      if (message.role === "user") chars.input += charsOf(message.content);
      else chars.reply += charsOf(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls) {
          const call = asRecord(raw);
          const callWeight = charsOf(raw);
          chars.toolCalls += callWeight;
          if (!call) continue;
          const name = callName(call);
          if (!name) continue;
          if (typeof call.id === "string") callNames.set(call.id, name);
          addTool(name, callWeight, true);
        }
      }
    }
  }

  if (sentChars + turnChars <= 0) return null;
  return {
    tokens: toTokens(sentChars + turnChars),
    toolTokens: toTokens(toolChars),
    sentTokens: toTokens(sentChars),
    breakdown: {
      instructions: toTokens(chars.instructions),
      history: toTokens(chars.history),
      input: toTokens(chars.input),
      toolCalls: toTokens(chars.toolCalls),
      toolResults: toTokens(chars.toolResults),
      reasoning: toTokens(chars.reasoning),
      reply: toTokens(chars.reply),
    },
    tools: [...tools.entries()]
      .map(([name, entry]) => ({ name, tokens: toTokens(entry.chars), calls: entry.calls }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      .slice(0, MAX_CONTEXT_TOOLS),
    source: "estimated",
  };
}

/** Garde de type côté client, jumelle de `isAgentPlan` et `isWebSearchTrail`. */
export function isContextUsageReading(value: unknown): value is ContextUsageReading {
  const reading = asRecord(value);
  return Boolean(
    reading
    && typeof reading.tokens === "number"
    && typeof reading.toolTokens === "number"
    && typeof reading.sentTokens === "number"
    && reading.source === "estimated",
  );
}

const BREAKDOWN_KEYS = [
  "instructions", "history", "input", "toolCalls", "toolResults", "reasoning", "reply",
] as const satisfies readonly (keyof ContextUsageBreakdown)[];

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Le détail d'une lecture relue depuis le journal, ou `null`. Un événement
 * persisté avant le détail n'en a pas, et un champ abîmé ne doit pas tracer
 * une barre fausse : tout ou rien.
 */
export function contextUsageBreakdown(reading: ContextUsageReading): ContextUsageBreakdown | null {
  const raw = asRecord(reading.breakdown);
  if (!raw) return null;
  const out = {} as ContextUsageBreakdown;
  for (const key of BREAKDOWN_KEYS) {
    const value = count(raw[key]);
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}

/** Les outils d'une lecture relue depuis le journal ; les entrées abîmées sont écartées. */
export function contextUsageTools(reading: ContextUsageReading): ContextUsageTool[] {
  if (!Array.isArray(reading.tools)) return [];
  const out: ContextUsageTool[] = [];
  for (const raw of reading.tools.slice(0, MAX_CONTEXT_TOOLS)) {
    const entry = asRecord(raw);
    const name = toolName(entry?.name);
    const tokens = count(entry?.tokens);
    const calls = count(entry?.calls);
    if (name && tokens !== null && calls !== null) out.push({ name, tokens, calls });
  }
  return out;
}
