// A long thread for D1d (docs/architecture/0001-refonte-tauri-et-produit.md,
// section 3.4): synthetic turns OLDER than a real thread's history, served by
// intercepting `GET /api/threads/:id/history`. The real thread keeps its
// latest pages, its live stream and its composer; past its oldest real page,
// "load earlier" walks synthetic pages of 40 turns, like the API pages them.
//
// The turns copy the shape of real runs (one `message.admitted`, the answer in
// `agent.message` chunks of ~130 characters, a `run.completed`), with what a
// long thread holds besides prose: fenced code (Shiki), tables, KaTeX, quotes,
// tool calls, and images (user and bot attachments, served with a delay so
// they change height after the turn is mounted).
//
// Deterministic: the same `turns` give the same ids, so the console's 5 s
// re-read merges the same rows instead of adding new ones.

export type FixtureRealPage = {
  messages: Array<{ sequence?: string | null; createdAt: string }>;
  events: Array<{ cursor: number }>;
  [key: string]: unknown;
};

export type LongThreadFixture = {
  /** Every synthetic turn, oldest first, split in pages of `pageTurns`. */
  pages: Array<{ messages: unknown[]; runs: unknown[]; events: unknown[]; turnKeys: string[] }>;
  turns: number;
};

export const SYNTHETIC_BEFORE_PREFIX = "d1d-synthetic:";
export const SYNTHETIC_ATTACHMENT_PREFIX = "d1d-img-";

const CHUNK = 130;

const PARAGRAPHS = [
  "La virtualisation d'une liste ne monte que ce que l'œil voit, plus une marge. Le reste existe dans le modèle, pas dans le DOM : sa hauteur est estimée, puis mesurée quand il entre dans la vue.",
  "Un fil de conversation se lit de bas en haut. Le lecteur arrive en bas, remonte pour relire, puis redescend vers la réponse en cours ; l'ancrage doit tenir dans les deux sens.",
  "Le coût d'un tour ne tient pas à sa longueur seule : un bloc de code surligné, un tableau large ou une formule pèsent plus que trois paragraphes de prose.",
  "Une image qui décode après le montage change la hauteur de son tour. Sans ancrage, tout ce qui est en dessous saute d'autant ; avec, la ligne lue reste sous les yeux.",
  "La sélection d'un passage qui traverse plusieurs messages suppose que ces messages existent dans le DOM au moment de la copie.",
  "Les lecteurs d'écran parcourent l'arbre d'accessibilité : un message démonté n'y figure plus, ce qui change l'ordre de lecture si rien ne le compense.",
];

const TS_CODE = `import { useEffect, useRef, useState } from "react";

type Turn = { id: string; text: string; height?: number };

export function useMeasuredTurns(turns: readonly Turn[]) {
  const heights = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.turnId;
        if (!id) continue;
        const next = Math.round(entry.contentRect.height);
        if (heights.current.get(id) !== next) {
          heights.current.set(id, next);
          changed = true;
        }
      }
      if (changed) setVersion((value) => value + 1);
    });
    return () => observer.disconnect();
  }, []);
  return { heights: heights.current, version, total: turns.length };
}`;

const PY_CODE = `from dataclasses import dataclass
from statistics import median


@dataclass
class Frame:
    at: float
    delta: float


def summarize(frames: list[Frame], refresh_hz: float = 120.0) -> dict:
    deltas = [frame.delta for frame in frames]
    if not deltas:
        return {"fps": None, "dropped": None}
    budget = 1000.0 / refresh_hz
    dropped = sum(1 for delta in deltas if delta > 1.5 * median(deltas))
    return {
        "fps": round(len(deltas) / (sum(deltas) / 1000.0), 1),
        "dropped_pct": round(100.0 * dropped / len(deltas), 1),
        "over_budget": sum(1 for delta in deltas if delta > budget),
    }`;

const BASH_CODE = `#!/usr/bin/env bash
set -euo pipefail
for size in 40 120 300; do
  bun apps/console/scripts/perf/long-thread.ts --turns "$size" --headed --runs 3
done
ls -1 tmp/perf | grep long-thread | tail -3`;

const JSON_CODE = `{
  "turns": 300,
  "mounted": { "before": 300, "after": 24 },
  "domNodes": { "before": 61234, "after": 5120 },
  "heapMb": { "before": 412.5, "after": 168.2 },
  "scroll": { "fpsP5": 112.4, "longFrames": 0 }
}`;

function table(index: number): string {
  const rows = Array.from({ length: 6 }, (_, row) =>
    `| Tour ${index * 6 + row} | ${(row * 37 + index) % 97} ms | ${(row * 13 + index) % 41} | ${row % 2 ? "oui" : "non"} |`);
  return ["| Étape | Durée | Nœuds | Contenu |", "|---|---:|---:|---|", ...rows].join("\n");
}

/** One of six answer shapes, from a two-line reply to a long article. */
export function syntheticAnswer(index: number): string {
  const p = (offset: number) => PARAGRAPHS[(index + offset) % PARAGRAPHS.length]!;
  switch (index % 6) {
    case 0:
      return `${p(0)}\n\n${p(1)}`;
    case 1:
      return `Voici une version qui mesure chaque tour sans relire le DOM à chaque frame :\n\n\`\`\`ts\n${TS_CODE}\n\`\`\`\n\n${p(2)}\n\nPour la rejouer :\n\n\`\`\`bash\n${BASH_CODE}\n\`\`\``;
    case 2:
      return [
        `## Tour ${index} : ce qui coûte dans un long fil`,
        p(0), p(1),
        "### Ce qu'on mesure",
        "- le premier rendu du fil ouvert\n- le défilement, en images par seconde\n- les frames longues, au-delà de 50 ms\n- la mémoire et les nœuds du DOM",
        p(2), p(3),
        "### Résultats",
        table(index),
        p(4), p(5),
        "### Lecture",
        "1. Le premier rendu dépend de la fenêtre montée, pas de la longueur du fil.\n2. Le défilement dépend de ce qui entre dans la vue.\n3. La mémoire dépend de tout ce qui reste monté.",
        p(0), p(1), p(2),
      ].join("\n\n");
    case 3:
      return `Le résumé des frames, en Python :\n\n\`\`\`python\n${PY_CODE}\n\`\`\`\n\nEt ce qu'il produit sur un essai :\n\n\`\`\`json\n${JSON_CODE}\n\`\`\`\n\n${table(index)}\n\n${p(3)}`;
    case 4:
      return `${p(4)}\n\n> ${p(5)}\n\nLa fréquence vise $f \\geq 0{,}9 \\times f_{\\text{écran}}$, et le coût d'un tour suit à peu près\n\n$$\nC(n) = \\sum_{i=1}^{n} \\left( a \\cdot \\ell_i + b \\cdot k_i \\right)\n$$\n\noù $\\ell_i$ est la longueur du texte et $k_i$ le nombre de blocs.\n\n- ${p(0)}\n- ${p(1)}`;
    default:
      return `${p(1)} Voir \`windowTimelineEntries\` et \`THREAD_LIVE_TURN_WINDOW\` dans [la note d'architecture](https://openedbot.app/docs).\n\n${p(2)}\n\n${p(3)}\n\n**À retenir :** ${p(5)}`;
  }
}

function syntheticQuestion(index: number): string {
  if (index % 5 === 0) return `Tour ${index}. ${PARAGRAPHS[index % PARAGRAPHS.length]} Peux-tu détailler ce que ça change pour un fil de plusieurs centaines de tours ?`;
  return `Tour ${index} : ${["et pour le code ?", "montre-moi un exemple", "résume ce que tu viens de dire", "et la mémoire ?", "quelle formule ?", "un tableau, s'il te plaît"][index % 6]}`;
}

const uuid = (kind: number, index: number) =>
  `d1d00000-0000-4000-8${kind.toString(16).padStart(3, "0")}-${index.toString(16).padStart(12, "0")}`;

/**
 * `turns` synthetic turns, all older than `oldest` (the oldest real page):
 * lower message sequences, lower event cursors (negative past zero, which the
 * console only ever compares), earlier timestamps, three turns an hour.
 */
export function buildLongThreadFixture(options: {
  turns: number;
  pageTurns?: number;
  oldest: FixtureRealPage;
  threadId: string;
  author: { id: string; name: string; slug: string; face: unknown };
}): LongThreadFixture {
  const pageTurns = options.pageTurns ?? 40;
  const realMinSeq = Math.min(0, ...options.oldest.messages.map((message) => Number(message.sequence ?? 0)));
  const realMinCursor = Math.min(...options.oldest.events.map((event) => event.cursor));
  const realMinAt = Math.min(...options.oldest.messages.map((message) => Date.parse(message.createdAt)));
  // Built newest first (index 0 sits right before the real history), then reversed.
  const turns: Array<{ messages: unknown[]; run: unknown; events: unknown[]; turnKey: string }> = [];
  let sequence = realMinSeq;
  let cursor = realMinCursor;
  for (let back = 0; back < options.turns; back += 1) {
    const index = options.turns - back;
    const answer = syntheticAnswer(index);
    const chunks: string[] = [];
    for (let at = 0; at < answer.length; at += CHUNK) chunks.push(answer.slice(at, at + CHUNK));
    const withTool = index % 4 === 2;
    const userImage = index % 10 === 3;
    const botImage = index % 7 === 5;
    const askedAt = realMinAt - (back + 1) * 20 * 60_000;
    const iso = (offsetMs: number) => new Date(askedAt + offsetMs).toISOString();
    const runId = uuid(1, index);
    const userId = uuid(2, index);
    const assistantId = uuid(3, index);
    const eventCount = 2 + chunks.length + (withTool ? 2 : 0);
    cursor -= eventCount;
    const firstCursor = cursor;
    const events: unknown[] = [];
    const push = (type: string, payload: Record<string, unknown>, offsetMs: number) => {
      events.push({ cursor: firstCursor + events.length, runId, sequence: events.length, type, payload, occurredAt: iso(offsetMs), threadId: options.threadId, botId: options.author.id, turnId: runId, version: 1 });
    };
    push("message.admitted", { runId, status: "queued", messageId: userId, workflowId: null }, 50);
    if (withTool) {
      push("tool.call", { tool: "terminal", preview: `rg -n windowTimelineEntries (tour ${index})`, toolCallId: "tc_0" }, 1_000);
      push("tool.result", { tool: "terminal", error: false, durationMs: 420, toolCallId: "tc_0", output: "apps/console/src/lib/thread/thread-window.ts:52:export function windowTimelineEntries" }, 1_500);
    }
    chunks.forEach((text, chunk) => push("agent.message", { text }, 2_000 + chunk * 120));
    push("run.completed", { usage: { inputTokens: 12_000, outputTokens: 900, totalTokens: 12_900 }, output: answer }, 2_000 + chunks.length * 120);
    sequence -= 2;
    const image = (id: string, name: string) => ({ type: "attachment", id, kind: "image", name, contentType: "image/svg+xml", bytes: 48_000 + index });
    const userMessage = {
      id: userId, sequence: String(sequence), runId, clientSubmissionId: null, authorBotId: null, role: "user",
      content: [{ type: "text", text: syntheticQuestion(index) }, ...(userImage ? [image(`${SYNTHETIC_ATTACHMENT_PREFIX}u${index}`, `capture-${index}.png`)] : [])],
      createdAt: iso(0), authorBot: null, replyTo: null, reactions: [],
    };
    const assistantMessage = {
      id: assistantId, sequence: String(sequence + 1), runId, clientSubmissionId: null, authorBotId: options.author.id, role: "assistant",
      content: [{ type: "text", text: answer }, ...(botImage ? [image(`${SYNTHETIC_ATTACHMENT_PREFIX}b${index}`, `schema-${index}.png`)] : [])],
      createdAt: iso(2_100 + chunks.length * 120), authorBot: options.author, replyTo: null, reactions: [],
    };
    const run = {
      id: runId, status: "completed", botId: options.author.id, input: syntheticQuestion(index), output: answer,
      usage: { inputTokens: 12_000, outputTokens: 900, totalTokens: 12_900 }, error: null, errorCode: null, model: "synthetic",
      hermesResponseId: null, createdAt: iso(20), startedAt: iso(40), endedAt: iso(2_000 + chunks.length * 120),
      lastEventAt: iso(2_000 + chunks.length * 120), workflowId: null, stepIndex: 0, stepKind: "root", stackDepth: 0,
      groupPhase: null, completionKind: "final", recoveryState: null, runtimeSession: null,
    };
    turns.push({ messages: [userMessage, assistantMessage], run, events, turnKey: `message:${userId}` });
  }
  turns.reverse();
  const pages: LongThreadFixture["pages"] = [];
  // Page 0 is the newest synthetic page (right before the real history).
  for (let end = turns.length; end > 0; end -= pageTurns) {
    const slice = turns.slice(Math.max(0, end - pageTurns), end);
    pages.push({
      messages: slice.flatMap((turn) => turn.messages),
      runs: slice.map((turn) => turn.run),
      events: slice.flatMap((turn) => turn.events),
      turnKeys: slice.map((turn) => turn.turnKey),
    });
  }
  return { pages, turns: options.turns };
}

/** An image of `index`'s size class, as SVG (the console shows it through a blob URL). */
export function syntheticImage(id: string): string {
  const seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const [width, height] = [[800, 450], [400, 600], [640, 640]][seed % 3]!;
  const hue = (seed * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 45%)"/><text x="50%" y="50%" font-family="sans-serif" font-size="32" fill="white" text-anchor="middle">${id}</text></svg>`;
}
