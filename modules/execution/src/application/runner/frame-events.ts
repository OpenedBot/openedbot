import type { HermesClient, HermesEvent } from "@openedbot/hermes";
import { readContextUsage } from "@openedbot/runtimes/domain/runtime/context-usage";
import { isTodoTool } from "../../domain/agent-tool-call";
import { projectToolResults } from "../../domain/agent-tool-results";
import type { HermesEventNormalizer, RunEvent } from "../../domain/hermes-events";
import { providerAuthRequiredPayload } from "../provider-fallback";
import type { RunCreateArgs } from "./run-state";
import { readAgentTranscript } from "./transcript";
import type { RunContext } from "./types";

/**
 * Les outils dont la fin justifie une relecture du transcript. Chacun écrit
 * quelque chose que le SSE ne transporte pas : la liste de tâches pour
 * `todo`, les sources pour une recherche web.
 */
export const TRANSCRIPT_TOOLS = new Set(["todo", "todo_list", "web_search", "search"]);

/**
 * Streaming: completes the events one Hermes frame normalized into, with
 * what the SSE does not carry. The provider whose login was refused names
 * its `run.error`; a finished `todo`, web search or failed tool, and a
 * `run.completed` without its turn's messages, re-read the transcript (plan,
 * sources, tool errors); a `run.completed` carries its turn's messages,
 * their tool results and the context the model had in hand. Reads the
 * transcript at most once; writes nothing.
 */
export async function enrichFrameEvents(
  context: Pick<RunContext, "id" | "organizationId" | "sessionId" | "workflowId">,
  client: HermesClient,
  normalizer: Pick<HermesEventNormalizer, "attachToolResults">,
  raw: HermesEvent,
  normalized: RunEvent[],
  frame: {
    /** Set when the run's own provider refused its login: its `run.error` names it. */
    authRequiredProvider: string | null;
    /** What the first creation sent; null for a resumed run. */
    createArgs: RunCreateArgs | null;
  },
): Promise<RunEvent[]> {
  let events = normalized;
  if (frame.authRequiredProvider) {
    const payload = providerAuthRequiredPayload(frame.authRequiredProvider);
    events = events.map((event) => event.type === "run.error" ? { ...event, payload } : event);
  }
  // Le SSE ne porte ni les arguments d'un outil ni son résultat. Dès
  // qu'une écriture `todo` ou une recherche web se termine, le
  // transcript est à jour : on relit, on projette, et on rattache. Ce
  // sont des états observés, jamais une progression simulée.
  //
  // Un `run.completed` qui porte déjà `messages` n'a rien à faire
  // relire : c'est le transcript AUTORITATIF DU TOUR, et le normaliseur
  // en a tiré plan et recherches. Relire la session par-dessus ne
  // ferait qu'y ramasser les tours précédents. La relecture reste donc
  // le chemin des projections en cours de run, et le repli d'un gateway
  // qui n'enverrait pas ce champ.
  const turnTranscript = Array.isArray(raw.messages) && raw.messages.length > 0
    ? raw.messages as unknown[]
    : null;
  const transcriptEventType = raw.event === "run.completed"
    ? (turnTranscript ? null : "run.completed")
    : raw.event === "tool.completed" && typeof raw.tool === "string" &&
      (TRANSCRIPT_TOOLS.has(raw.tool) || isTodoTool(raw.tool) || raw.error === true)
      ? "tool.result"
      : null;
  let reReadTurn: unknown[] | null = null;
  if (transcriptEventType && events.some((event) => event.type === transcriptEventType)) {
    const { agentPlan, webSearch, turn } = await readAgentTranscript(context, client);
    reReadTurn = turn;
    if (agentPlan || webSearch) {
      events = events.map((event) => event.type === transcriptEventType
        ? {
            ...event,
            payload: {
              ...event.payload,
              ...(agentPlan ? { agentPlan } : {}),
              ...(webSearch ? { webSearch } : {}),
            },
          }
        : event);
    }
  }
  // Le transcript du tour porte les arguments d'écriture. On le pose
  // sur l'événement le temps de `persistEvents`, qui le retire avant
  // l'insert : le journal SSE ne doit pas embarquer le HTML entier.
  if (raw.event === "run.completed") {
    const turnMessages = turnTranscript ?? reReadTurn;
    if (Array.isArray(turnMessages) && turnMessages.length > 0) {
      events = events.map((event) => event.type === "run.completed"
        ? { ...event, payload: { ...event.payload, turnMessages } }
        : event);
      events.push(...normalizer.attachToolResults(turnMessages));
    }
  }
  if (raw.event === "tool.completed" && raw.error === true && reReadTurn) {
    const tool = typeof raw.tool === "string" ? raw.tool : null;
    if (tool) {
      const projected = projectToolResults(reReadTurn).filter((entry) => entry.tool === tool);
      const upstreamCallId = typeof (raw as unknown as Record<string, unknown>).tool_call_id === "string"
        ? String((raw as unknown as Record<string, unknown>).tool_call_id)
        : null;
      const transcriptResult = (upstreamCallId
        ? projected.find((entry) => entry.callId === upstreamCallId)
        : null) ?? projected[projected.length - 1];
      if (transcriptResult?.errorMessage) {
        events = events.map((event) => event.type === "tool.result" && event.payload.tool === tool &&
          !event.payload.errorMessage
          ? { ...event, payload: { ...event.payload, errorMessage: transcriptResult.errorMessage } }
          : event);
      }
    }
  }
  // Ce que le modèle avait RÉELLEMENT en main à la fin du tour : ce qui
  // lui a été envoyé, plus ce que le tour a fait pousser (appels d'outils
  // et résultats). Aucun appel réseau de plus : l'envoi vient de
  // `createArgs`, le transcript du tour du SSE lui-même.
  if (raw.event === "run.completed" && frame.createArgs) {
    const contextUsage = readContextUsage({
      instructions: frame.createArgs.instructions,
      history: frame.createArgs.history,
      input: frame.createArgs.input,
      turnMessages: turnTranscript ?? reReadTurn,
    });
    if (contextUsage) {
      events = events.map((event) => event.type === "run.completed"
        ? { ...event, payload: { ...event.payload, contextUsage } }
        : event);
    }
  }
  return events;
}
