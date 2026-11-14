import type { HermesClient, HermesWorkspaceFile } from "@openedbot/hermes";
import type { RunContext } from "./types";
import { log } from "./util";

/**
 * Lit sur l'hôte les fichiers qu'une réponse désigne dans `/workspace`
 * (`workspaceMediaNames`), en parallèle : il y en a au plus le nombre de
 * pièces jointes d'un message. Best-effort : un hôte qui ne connaît pas la
 * route, un fichier absent ou refusé laisse le nom dans le texte, jamais un
 * run en échec.
 */
export async function fetchWorkspaceMedia(
  context: Pick<RunContext, "id" | "organizationId">,
  client: Pick<HermesClient, "hostWorkspaceFile"> | undefined,
  names: readonly string[],
): Promise<Map<string, HermesWorkspaceFile>> {
  const fetched = new Map<string, HermesWorkspaceFile>();
  if (!client || names.length === 0) return fetched;
  await Promise.all(names.map(async (name) => {
    try {
      fetched.set(name, await client.hostWorkspaceFile(name));
    } catch (error) {
      const failure = error as { status?: unknown; code?: unknown };
      log("worker.output_media_fetch_failed", {
        runId: context.id,
        organizationId: context.organizationId,
        file: name,
        status: typeof failure.status === "number" ? failure.status : null,
        code: typeof failure.code === "string" ? failure.code : null,
      });
    }
  }));
  return fetched;
}
