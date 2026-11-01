/**
 * Thread lab (dev only, `/dev/thread-lab`): scripted replies played as the
 * SAME product events the worker writes (`agent.message` flush fragments,
 * `tool.call`, `tool.result`, `tool.result.attached`, `run.completed`,
 * `run.error`, the cancel `system.notice`), so the current `ThreadTimeline`
 * and the prototype thread render one identical stream side by side.
 *
 * No `agent.reasoning`: the worker never emits it (`reasoning.available` is
 * dropped in `modules/execution/src/domain/hermes-events.ts`), so the
 * prototype reads "thinking" from the narration that precedes a tool, as the
 * current thread does.
 */
import type { ProductRunStatus } from "@openedbot/contracts-api";
import type { ProductEventType, StoredProductEvent } from "@openedbot/contracts-events";
import { isConfirmedLiveAnswer } from "../live-answer";

export type LabStep =
  /** Text streamed as `agent.message` fragments. Before a tool it reads as narration. */
  | { kind: "say"; text: string }
  | {
      kind: "tool";
      tool: string;
      preview?: string;
      /** Live, bounded excerpt carried by `tool.result`. */
      excerpt?: string;
      /** Full transcript, attached after the run (`tool.result.attached`). */
      result?: string;
      durationMs: number;
      errorMessage?: string;
    }
  /** The run ends on `run.error` instead of `run.completed`. */
  | { kind: "fail"; message: string };

export type LabScenario = {
  id: string;
  label: string;
  prompt: string;
  steps: readonly LabStep[];
  followUps: readonly string[];
};

export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: "answer",
    label: "Réponse markdown",
    prompt: "SSE, WebSocket ou polling pour streamer une réponse de chat ?",
    followUps: ["Montre la reprise avec Last-Event-ID", "Et derrière un proxy Cloudflare ?"],
    steps: [
      {
        kind: "say",
        text: [
          "Pour une interface de chat, **Server-Sent Events** est le bon défaut : le serveur pousse les tokens sur une seule réponse HTTP longue, et le navigateur se reconnecte seul.",
          "",
          "## Quand choisir quoi",
          "- **SSE** : flux à sens unique. HTTP simple, passe les proxys, reprend avec `Last-Event-ID`.",
          "- **WebSocket** : trafic bidirectionnel, voix, interruption du modèle en cours de réponse.",
          "- **Polling** : seulement quand on ne peut pas garder une connexion ouverte.",
          "",
          "## Lire le flux",
          "```ts",
          "const res = await fetch(\"/api/chat\", { method: \"POST\", body });",
          "const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();",
          "for (;;) {",
          "  const { value, done } = await reader.read();",
          "  if (done) break;",
          "  setAnswer((prev) => prev + value);",
          "}",
          "```",
          "",
          "Rendez les tokens à l'arrivée, gardez le fil épinglé en bas, et transformez Envoyer en **Stop**.",
        ].join("\n"),
      },
    ],
  },
  {
    id: "tools",
    label: "Outils puis réponse",
    prompt: "Pourquoi le test de checkout est-il instable ?",
    followUps: ["Corrige-le", "Lance toute la suite"],
    steps: [
      { kind: "say", text: "Je cherche d'abord le test et ses dépendances." },
      {
        kind: "tool",
        tool: "search_files",
        preview: "checkout.test.ts",
        excerpt: "tests/checkout.test.ts\ntests/fixtures/cart.ts",
        result: "tests/checkout.test.ts:12\ntests/checkout.test.ts:48\ntests/fixtures/cart.ts:3",
        durationMs: 700,
      },
      {
        kind: "tool",
        tool: "read_file",
        preview: "tests/checkout.test.ts",
        excerpt: "await page.click(\"#pay\");\nexpect(await total()).toBe(42);",
        result: "it(\"pays\", async () => {\n  await page.click(\"#pay\");\n  expect(await total()).toBe(42);\n});",
        durationMs: 500,
      },
      { kind: "say", text: "Je relance le test dix fois pour mesurer l'instabilité." },
      {
        kind: "tool",
        tool: "terminal",
        preview: "bun test tests/checkout.test.ts --rerun-each 10",
        excerpt: "8 pass\n2 fail",
        result: "checkout.test.ts:\n✓ pays [41ms]\n✗ pays [timeout 5000ms]\n✓ pays [39ms]\n…\n8 pass\n2 fail",
        durationMs: 1600,
      },
      {
        kind: "say",
        text: [
          "Le test clique sur **Payer** avant que le total soit recalculé : deux exécutions sur dix lisent l'ancien total.",
          "",
          "1. Attendre `total()` après le clic plutôt que de le lire tout de suite.",
          "2. Retirer le `setTimeout` de la fixture `cart.ts`, qui masque la course.",
        ].join("\n"),
      },
    ],
  },
  {
    id: "tool-error",
    label: "Outil en échec",
    prompt: "Déploie la branche sur staging",
    followUps: ["Réessaie avec le bon contexte", "Montre les logs complets"],
    steps: [
      { kind: "say", text: "Je vérifie l'état du cluster avant de déployer." },
      {
        kind: "tool",
        tool: "terminal",
        preview: "kubectl get pods -n staging",
        excerpt: "error: context \"staging\" not found",
        result: "error: context \"staging\" not found\nexit status 1",
        durationMs: 900,
        errorMessage: "command failed: exit status 1",
      },
      {
        kind: "say",
        text: "Le contexte `staging` n'existe pas sur cette machine : je n'ai rien déployé. Ajoutez-le avec `kubectl config set-context`, puis relancez-moi.",
      },
    ],
  },
  {
    id: "run-failed",
    label: "Run en erreur",
    prompt: "Résume la réunion de ce matin",
    followUps: ["Réessaie"],
    steps: [
      { kind: "say", text: "Je récupère la transcription." },
      { kind: "tool", tool: "web_extract", preview: "meet.example.com/rec/42", durationMs: 1200, errorMessage: "403 Forbidden" },
      { kind: "fail", message: "Le fournisseur a refusé la requête (quota dépassé)." },
    ],
  },
];

export function labScenario(id: string): LabScenario {
  return LAB_SCENARIOS.find((scenario) => scenario.id === id) ?? LAB_SCENARIOS[0]!;
}

/** One event to fire `delayMs` after the previous one (at 1x speed). */
export type LabScheduledEvent = {
  delayMs: number;
  type: ProductEventType;
  payload: Record<string, unknown>;
};

/** Time before the first runtime event, then between two text fragments (the worker's 100 ms flush window). */
const FIRST_EVENT_MS = 650;
const FRAGMENT_MS = 100;
const WORDS_PER_FRAGMENT = 4;
const AFTER_TOOL_MS = 250;

/** Cuts a text into flush-sized fragments whose concatenation is the original, byte for byte. */
export function labFragments(text: string, wordsPerFragment = WORDS_PER_FRAGMENT): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const fragments: string[] = [];
  for (let index = 0; index < words.length; index += wordsPerFragment) {
    fragments.push(words.slice(index, index + wordsPerFragment).join(""));
  }
  return fragments;
}

/**
 * The scenario as a relative schedule. Pure: cursors, sequences and dates are
 * stamped when each event fires, so a stopped run simply stops consuming it.
 */
export function planLabReply(scenario: LabScenario): LabScheduledEvent[] {
  const plan: LabScheduledEvent[] = [];
  const attached: LabScheduledEvent[] = [];
  let pending = FIRST_EVENT_MS;
  let toolIndex = 0;
  let failed: string | null = null;
  for (const step of scenario.steps) {
    if (step.kind === "say") {
      for (const text of labFragments(step.text)) {
        plan.push({ delayMs: pending, type: "agent.message", payload: { text } });
        pending = FRAGMENT_MS;
      }
      pending = AFTER_TOOL_MS;
      continue;
    }
    if (step.kind === "fail") {
      failed = step.message;
      break;
    }
    const toolCallId = `lab-tc-${toolIndex++}`;
    plan.push({
      delayMs: pending,
      type: "tool.call",
      payload: { toolCallId, tool: step.tool, ...(step.preview ? { preview: step.preview } : {}) },
    });
    plan.push({
      delayMs: step.durationMs,
      type: "tool.result",
      payload: {
        toolCallId,
        tool: step.tool,
        durationMs: step.durationMs,
        error: step.errorMessage !== undefined,
        errorMessage: step.errorMessage ?? null,
        resultExcerpt: step.excerpt ?? null,
        hasResultPayload: step.result !== undefined,
      },
    });
    if (step.result !== undefined) {
      attached.push({ delayMs: 0, type: "tool.result.attached", payload: { toolCallId, input: step.preview ?? "", result: step.result } });
    }
    pending = AFTER_TOOL_MS;
  }
  if (failed !== null) {
    plan.push({ delayMs: pending, type: "run.error", payload: { message: failed } });
    return plan;
  }
  // The full transcripts land after the run, just before it is marked done.
  plan.push(...attached.map((event, index) => (index === 0 ? { ...event, delayMs: pending } : event)));
  plan.push({ delayMs: attached.length ? 0 : pending, type: "run.completed", payload: {} });
  return plan;
}

export type LabRun = {
  id: string;
  status: ProductRunStatus;
  model: string | null;
  createdAt: string;
  endedAt: string | null;
};

export type LabUserInput = {
  id: string;
  text: string;
  runId: string | null;
  createdAt: string;
};

export type LabToolPart = {
  kind: "tool";
  id: string;
  tool: string;
  preview: string | null;
  status: "running" | "done" | "error";
  durationMs: number | null;
  errorMessage: string | null;
  excerpt: string | null;
  result: string | null;
};

export type LabActivityPart = { kind: "narration"; id: string; text: string } | LabToolPart;

export type LabAssistantTurn = {
  runId: string;
  status: ProductRunStatus;
  model: string | null;
  /** Narration and tools, in order. */
  activity: LabActivityPart[];
  /** The answer: the text after the last tool (or all of it with no tool), once confirmed. */
  answer: string;
  /**
   * Live text not yet known to be the answer: it may still be narration that a
   * tool call follows. Shown as the working indicator's label, never in the
   * answer slot, so nothing jumps from the answer into the work block.
   */
  liveNote: string;
  errorMessage: string | null;
  cancelled: boolean;
  startedAt: string;
  endedAt: string | null;
};

export type LabTurn = { user: LabUserInput; assistant: LabAssistantTurn | null };

export function isLabRunLive(status: ProductRunStatus): boolean {
  return status === "queued" || status === "pending" || status === "starting" || status === "running" || status === "awaiting_approval";
}

/** The prototype's view model, derived from the same events as `ThreadTimeline`. */
export function deriveLabTurns(
  userInputs: readonly LabUserInput[],
  events: readonly StoredProductEvent[],
  runs: readonly LabRun[],
): LabTurn[] {
  const eventsByRun = new Map<string, StoredProductEvent[]>();
  for (const event of events) {
    const list = eventsByRun.get(event.runId);
    if (list) list.push(event);
    else eventsByRun.set(event.runId, [event]);
  }
  const runById = new Map(runs.map((run) => [run.id, run]));
  return userInputs.map((user) => {
    const run = user.runId ? runById.get(user.runId) : undefined;
    return { user, assistant: run ? deriveAssistantTurn(run, eventsByRun.get(run.id) ?? []) : null };
  });
}

function deriveAssistantTurn(run: LabRun, events: readonly StoredProductEvent[]): LabAssistantTurn {
  type Segment = { kind: "text"; id: string; text: string } | LabToolPart;
  const segments: Segment[] = [];
  const tools = new Map<string, LabToolPart>();
  let errorMessage: string | null = null;
  let cancelled = false;
  for (const event of [...events].sort((a, b) => a.cursor - b.cursor)) {
    const payload = event.payload;
    if (event.type === "agent.message") {
      const text = typeof payload.text === "string" ? payload.text : "";
      const last = segments[segments.length - 1];
      if (last?.kind === "text") last.text += text;
      else segments.push({ kind: "text", id: `text-${event.cursor}`, text });
    } else if (event.type === "tool.call") {
      const id = typeof payload.toolCallId === "string" ? payload.toolCallId : `tool-${event.cursor}`;
      const part: LabToolPart = {
        kind: "tool",
        id,
        tool: typeof payload.tool === "string" ? payload.tool : "tool",
        preview: typeof payload.preview === "string" ? payload.preview : null,
        status: "running",
        durationMs: null,
        errorMessage: null,
        excerpt: null,
        result: null,
      };
      tools.set(id, part);
      segments.push(part);
    } else if (event.type === "tool.result") {
      const part = typeof payload.toolCallId === "string" ? tools.get(payload.toolCallId) : undefined;
      if (!part) continue;
      part.status = payload.error === true ? "error" : "done";
      part.durationMs = typeof payload.durationMs === "number" ? payload.durationMs : null;
      part.errorMessage = typeof payload.errorMessage === "string" ? payload.errorMessage : null;
      part.excerpt = typeof payload.resultExcerpt === "string" ? payload.resultExcerpt : null;
    } else if (event.type === "tool.result.attached") {
      const part = typeof payload.toolCallId === "string" ? tools.get(payload.toolCallId) : undefined;
      if (part && typeof payload.result === "string") part.result = payload.result;
    } else if (event.type === "run.error") {
      errorMessage = typeof payload.message === "string" ? payload.message : "Erreur";
    } else if (event.type === "system.notice" && payload.kind === "cancelled") {
      cancelled = true;
    }
  }

  const live = isLabRunLive(run.status);
  const last = segments[segments.length - 1];
  const trailing = last?.kind === "text" ? last.text : null;
  const trailingIsAnswer = trailing !== null && (!live || isConfirmedLiveAnswer(trailing));
  const body = trailing !== null ? segments.slice(0, -1) : segments;
  const activity: LabActivityPart[] = body.map((segment) =>
    segment.kind === "text" ? { kind: "narration", id: segment.id, text: segment.text.trim() } : segment,
  );
  return {
    runId: run.id,
    status: run.status,
    model: run.model,
    activity,
    answer: trailingIsAnswer ? trailing : "",
    liveNote: trailing !== null && !trailingIsAnswer ? trailing.trim() : "",
    errorMessage,
    cancelled,
    startedAt: run.createdAt,
    endedAt: run.endedAt,
  };
}
