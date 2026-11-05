import { useCallback, useEffect, useState } from "react";

/**
 * Le plan n'a pas de DTO. Le worker ajoute une consigne au prompt
 * (`buildEditorDirectivesBlock`) et le modèle répond en prose.
 * Cette lecture en tire objectif, étapes, périmètre, ou, à défaut, un
 * objectif et le corps tel quel.
 */

export type PlanDraft = {
  objective: string;
  steps: string[];
  willTouch: string[];
  willNotTouch: string[];
  /** Prose qui n'est ni une étape ni un périmètre (souvent « Confirme… »). */
  note: string;
  code: string;
};

export type PlanTurn = {
  phase: "awaiting" | "pending" | "executing";
  /** Dernier message connu au moment de l'envoi : tout ce qui suit est le tour. */
  anchorMessageId: string | null;
  messageId: string | null;
  runId: string | null;
};

const PREVIEW_KEY = "openedbot:plan-preview";
export const PLAN_PREVIEW_EVENT = "openedbot-plan-preview";

function devBuild(): boolean {
  return import.meta.env.DEV === true;
}

export function planPreviewEnabled(): boolean {
  if (!devBuild() || typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPlanPreview(): void {
  try {
    window.sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // La prévisualisation ne tient qu'à cet onglet.
  }
  window.dispatchEvent(new Event(PLAN_PREVIEW_EVENT));
}

function planFirstKey(scope: string): string {
  return `openedbot:plan-first:${scope}`;
}

function readPlanFirst(scope: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(planFirstKey(scope)) === "1";
  } catch {
    return false;
  }
}

/**
 * « Planifier d'abord » (menu +) : une intention du fil, pas un mode du bot.
 * Tant qu'elle est posée, chaque message part en `planOnly` (0155) : le bot
 * propose un plan sans rien modifier, ses routines et ses autres fils
 * gardent leur mode. Lancer l'exécution la retire. Gardée par onglet, comme
 * la carte du plan.
 */
export function usePlanFirst(scope: string): [boolean, (next: boolean) => void] {
  const [armed, setArmedState] = useState(() => readPlanFirst(scope));
  useEffect(() => setArmedState(readPlanFirst(scope)), [scope]);
  const setArmed = useCallback((next: boolean) => {
    try {
      if (next) window.sessionStorage.setItem(planFirstKey(scope), "1");
      else window.sessionStorage.removeItem(planFirstKey(scope));
    } catch {
      // Stockage refusé : l'intention vit le temps de la page.
    }
    setArmedState(next);
  }, [scope]);
  return [armed, setArmed];
}

function turnKey(threadId: string): string {
  return `openedbot:plan-turn:${threadId}`;
}

export function readPlanTurn(threadId: string): PlanTurn | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(turnKey(threadId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PlanTurn>;
    if (value.phase !== "awaiting" && value.phase !== "pending" && value.phase !== "executing") return null;
    return {
      phase: value.phase,
      anchorMessageId: typeof value.anchorMessageId === "string" ? value.anchorMessageId : null,
      messageId: typeof value.messageId === "string" ? value.messageId : null,
      runId: typeof value.runId === "string" ? value.runId : null,
    };
  } catch {
    return null;
  }
}

export function writePlanTurn(threadId: string, turn: PlanTurn | null): void {
  try {
    const key = turnKey(threadId);
    if (!turn) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(turn));
  } catch {
    // Sans stockage, la carte vit le temps du rendu.
  }
}

export function messagesAfter<T extends { id: string }>(messages: readonly T[], anchorId: string | null): T[] {
  if (!anchorId) return [...messages];
  const index = messages.findIndex((message) => message.id === anchorId);
  return index === -1 ? [] : messages.slice(index + 1);
}

export function textOfContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.map((part) => (part.type === "text" && part.text ? part.text : "")).join("");
}

export function assistantEventText(
  events: readonly { runId?: string | null; type: string; payload?: { text?: unknown } }[],
  runId: string | null,
): string {
  if (!runId) return "";
  let text = "";
  for (const event of events) {
    if (event.runId !== runId || event.type !== "agent.message") continue;
    if (typeof event.payload?.text === "string") text += event.payload.text;
  }
  return text;
}

/**
 * Plan réaliste pour la passe visuelle tant que le bot ne renvoie pas
 * cette forme. Activé en dev par `sessionStorage["openedbot:plan-preview"]="1"`.
 */
export const PLAN_PREVIEW_SOURCE = `Objectif
Publier la page d’actualités IA de la semaine, en français, sans rien envoyer.

Étapes
1. Choisir cinq sources publiées entre le 30 septembre et le 6 octobre 2026.
2. Écrire une page HTML responsive, esthétique éditoriale, dans un seul fichier.
3. Relier chaque carte à sa source (TechCrunch ou The Verge), avec la date et le résumé.
4. Vérifier que le fichier s’ouvre en local. Ne pas le publier.

Ce que je vais toucher
- /root/actualite-ia-semaine.html

Ce que je ne toucherai pas
- Le cron Hermes et le planificateur du runtime
- Les autres fichiers du workspace
- Tout envoi vers l’extérieur

\`\`\`
python3 -c "from pathlib import Path; p=Path('/root/actualite-ia-semaine.html'); print(p.exists(), p.stat().st_size if p.exists() else 0)"
\`\`\`
`;

type Section = "objective" | "steps" | "will" | "wont" | "note";

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function classifyHeading(line: string): Section | null {
  if (/^(?:\d+[.)]|[-*•])\s+/.test(line.trim())) return null;
  const heading = fold(line.replace(/^#{1,3}\s+/, "").replace(/\*\*/g, "").replace(/:\s*$/, "").trim());
  if (!heading || heading.length > 72) return null;
  if (/^(objectif|objective|goal)\b/.test(heading)) return "objective";
  if (/^(etapes|steps|plan)\b/.test(heading)) return "steps";
  const scope = /^(ce que|what it|what this)\b/.test(heading)
    || /^(perimetre|hors perimetre|hors scope|will touch|will not touch|won't touch)$/.test(heading);
  if (!scope) return null;
  return /\b(pas|not)\b|won't|ne pas|n'y/.test(heading) ? "wont" : "will";
}

function stripItem(line: string): { text: string; item: boolean } {
  const numbered = /^(?:\d+[.)]\s+)(.+)$/.exec(line);
  if (numbered?.[1]) return { text: numbered[1].trim(), item: true };
  const bullet = /^(?:[-*•]\s+)(.+)$/.exec(line);
  if (bullet?.[1]) return { text: bullet[1].trim(), item: true };
  return { text: line.trim(), item: false };
}

function splitFences(source: string): { prose: string; code: string } {
  const prose: string[] = [];
  const code: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    prose.push(source.slice(last, match.index));
    code.push(match[1]?.replace(/\s+$/, "") ?? "");
    last = match.index + match[0].length;
  }
  prose.push(source.slice(last));
  return { prose: prose.join("\n"), code: code.filter(Boolean).join("\n\n") };
}

const CLOSING = /^(confirme|confirm|dis-moi|j'attends|j’attends|je m'arrête|je m’arrête|en attente)\b/i;

export function parsePlanDraft(source: string): PlanDraft {
  const empty: PlanDraft = { objective: "", steps: [], willTouch: [], willNotTouch: [], note: "", code: "" };
  const trimmed = source.trim();
  if (!trimmed) return empty;
  const { prose, code } = splitFences(trimmed);
  const buckets: Record<Section, string[]> = { objective: [], steps: [], will: [], wont: [], note: [] };
  let section: Section = "note";
  let sawHeading = false;

  for (const raw of prose.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = classifyHeading(line);
    if (heading) {
      section = heading;
      sawHeading = true;
      continue;
    }
    const item = stripItem(line);
    if (!item.text) continue;
    if (section === "steps" || (!sawHeading && item.item)) buckets.steps.push(item.text);
    else if (section === "will" || section === "wont") buckets[section].push(item.text);
    else buckets[section].push(item.text);
  }

  if (!sawHeading && buckets.steps.length === 0) {
    const lines = prose.split("\n").map((line) => line.trim()).filter(Boolean);
    const steps: string[] = [];
    const notes: string[] = [];
    for (const line of lines) {
      const item = stripItem(line);
      if (CLOSING.test(item.text)) notes.push(item.text);
      else steps.push(item.text);
    }
    if (steps.length >= 2) {
      return { ...empty, steps, note: notes.join("\n"), code };
    }
    const [objective = "", ...rest] = lines;
    return { ...empty, objective, note: rest.join("\n"), code };
  }

  const noteLines = buckets.note.filter((line) => !CLOSING.test(line) || buckets.steps.length === 0);
  const closing = buckets.note.filter((line) => CLOSING.test(line));
  return {
    objective: buckets.objective.join(" "),
    steps: buckets.steps,
    willTouch: buckets.will,
    willNotTouch: buckets.wont,
    note: [...(buckets.steps.length ? closing : []), ...noteLines].join("\n"),
    code,
  };
}
