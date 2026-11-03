import type { HermesClient } from "@openedbot/hermes";
import type { RunEvent } from "../../domain/hermes-events";
import { projectAgentPlan, type AgentPlan } from "@openedbot/execution/domain/agent-plan";
import { projectWebSearches, type WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { currentTurnMessages } from "@openedbot/execution/domain/agent-transcript";
import { projectRuntimeArtifacts, type RuntimeArtifact } from "@openedbot/execution/domain/runtime-artifacts";
import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { artifactObjectKey, putArtifactBlob } from "../artifact-store";
import type { MessageContent } from "@openedbot/contracts-api";
import type { WorkerConfig } from "../worker-config";
import type { RunContext } from "./types";
import { describe, log } from "./util";

/**
 * Les arguments d'un appel d'outil ne sont pas dans le SSE Hermes. Le gateway
 * les conserve toutefois dans le transcript de session : une lecture bornée
 * et best-effort après chaque écriture `todo`, puis à `run.completed`, permet
 * de rendre le plan vivant sans modifier le runtime.
 */
export async function readAgentTranscript(
  context: Pick<RunContext, "id" | "organizationId" | "sessionId" | "workflowId">,
  client: HermesClient,
): Promise<{ agentPlan: AgentPlan | null; webSearch: WebSearchTrail | null; turn: unknown[] }> {
  try {
    // Une seule relecture pour les deux projections : le transcript est un
    // appel réseau, et plan comme recherches y lisent les mêmes messages.
    //
    // La page rendue porte TOUTE la session, tours précédents compris : une
    // session de bot est persistante. Sans la borne au tour courant, le fil
    // recollait sur un message les requêtes et les étapes d'avant.
    const turn = currentTurnMessages(await client.sessionMessages(context.sessionId));
    return { agentPlan: projectAgentPlan(turn), webSearch: projectWebSearches(turn), turn };
  } catch (error) {
    log("worker.agent_transcript_unavailable", {
      runId: context.id,
      organizationId: context.organizationId,
      workflowId: context.workflowId,
      error: describe(error),
    });
    // Plan et recherches sont des aides de lecture, jamais une raison de
    // faire échouer le run, actif ou déjà terminé.
    return { agentPlan: null, webSearch: null, turn: [] };
  }
}

type StoredRuntimeArtifact = {
  id: string;
  name: string;
  contentType: string;
  kind: "image" | "document";
  bytes: number;
  objectKey: string;
  driver: "file" | "r2";
};

export function assistantContent(
  message: string | null,
  artifacts: readonly StoredRuntimeArtifact[],
): MessageContent {
  const content: MessageContent = [];
  const trimmed = message?.trim() ?? "";
  if (trimmed) content.push({ type: "text", text: trimmed });
  for (const artifact of artifacts) {
    content.push({
      type: "attachment",
      id: artifact.id,
      name: artifact.name,
      contentType: artifact.contentType,
      kind: artifact.kind,
      bytes: artifact.bytes,
    });
  }
  return content;
}

/**
 * Copie les fichiers monstrables du tour vers le magasin des pièces jointes.
 *
 * Le contenu vient des arguments d'écriture du transcript (le connecteur
 * n'a pas de lecture de fichier) et des images que la réponse finale livrait
 * intégrées (`extractOutputMedia`), dans les limites d'un message.
 * Best-effort : un blob refusé n'échoue pas le run.
 */
export async function storeRuntimeArtifacts(
  config: WorkerConfig,
  context: Pick<RunContext, "id" | "organizationId" | "sessionId" | "workflowId">,
  event: RunEvent,
  client: HermesClient | undefined,
  delivered: readonly RuntimeArtifact[] = [],
): Promise<StoredRuntimeArtifact[]> {
  if (!config.blob) {
    if (delivered.length) log("worker.output_media_dropped", { runId: context.id, organizationId: context.organizationId, reason: "no_blob_store", count: delivered.length });
    return [];
  }
  let messages = Array.isArray(event.payload.turnMessages) ? event.payload.turnMessages : null;
  if (!messages && client) {
    const transcript = await readAgentTranscript(context, client);
    messages = transcript.turn;
  }
  const projected = withinMessageLimits([...(messages?.length ? projectRuntimeArtifacts(messages) : []), ...delivered]);
  if (projected.length === 0) return [];
  const stored: StoredRuntimeArtifact[] = [];
  for (const artifact of projected) {
    const id = crypto.randomUUID();
    try {
      const objectKey = artifactObjectKey(context.organizationId, id);
      const driver = await putArtifactBlob(config.blob, objectKey, artifact.data, artifact.contentType);
      stored.push({
        id,
        name: artifact.name,
        contentType: artifact.contentType,
        kind: artifact.kind,
        bytes: artifact.data.byteLength,
        objectKey,
        driver,
      });
    } catch (error) {
      log("worker.runtime_artifact_store_failed", {
        runId: context.id,
        organizationId: context.organizationId,
        name: artifact.name,
        error: describe(error),
      });
    }
  }
  return stored;
}

/** Le transcript et la réponse se partagent les limites d'un même message. */
function withinMessageLimits(artifacts: readonly RuntimeArtifact[]): RuntimeArtifact[] {
  const kept: RuntimeArtifact[] = [];
  let total = 0;
  for (const artifact of artifacts) {
    if (kept.length >= ATTACHMENT_LIMITS.maxCount) break;
    if (total + artifact.data.byteLength > ATTACHMENT_LIMITS.maxBytesTotal) continue;
    kept.push(artifact);
    total += artifact.data.byteLength;
  }
  return kept;
}
