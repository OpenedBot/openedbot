import { WORKSPACE_FILE_NAME_PATTERN, type HermesClient } from "@openedbot/hermes";
import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { mediaBasename } from "../../domain/output-media-text";
import { deliverableType, isTextDeliverable, writtenWorkspaceText } from "../../domain/output-workspace-files";
import type { RuntimeArtifact } from "../../domain/runtime-artifacts";
import type { RunContext } from "./types";
import { log } from "./util";

/**
 * Turns the files a reply cites as plain `/workspace/<path>` references
 * (`citedWorkspacePaths`) into attachments, like a `MEDIA:` delivery.
 *
 * The bytes come from the host first (`workspace/files`, which serves a root
 * name of an image, a PDF or a text file, whatever wrote it, the terminal
 * included), then, for text, from this turn's write calls in the transcript
 * (the content a `write_file` gave that path): it covers a nested path and a
 * host older than edge-setup v1.5.12, whose route serves no text. A path
 * neither source knows is a mention, not a delivery: it is skipped, logged
 * at debug, never an error.
 */
export async function citedWorkspaceArtifacts(
  context: Pick<RunContext, "id" | "organizationId">,
  client: Pick<HermesClient, "hostWorkspaceFile"> | undefined,
  paths: readonly string[],
  turnMessages: unknown,
): Promise<RuntimeArtifact[]> {
  const resolved = await Promise.all(paths.map(async (path): Promise<RuntimeArtifact | null> => {
    const type = deliverableType(path);
    if (!type) return null;
    const name = mediaBasename(path);
    let reason = "not_found";
    if (client && WORKSPACE_FILE_NAME_PATTERN.test(path)) {
      try {
        const file = await client.hostWorkspaceFile(path);
        const kind = file.contentType.startsWith("image/") ? "image" : "document";
        return { path: name, name, contentType: file.contentType, kind, data: file.bytes };
      } catch (error) {
        const failure = error as { status?: unknown; code?: unknown };
        reason = typeof failure.code === "string" ? failure.code : "host_read_failed";
      }
    }
    // Only text from the transcript: a binary written there is base64 or a
    // data URL, which `projectRuntimeArtifacts` already attaches.
    const written = isTextDeliverable(path) ? writtenWorkspaceText(turnMessages, path) : null;
    const data = written === null ? null : new TextEncoder().encode(written);
    if (data && data.byteLength > 0 && data.byteLength <= ATTACHMENT_LIMITS.maxBytesEach) {
      return { path: name, name, contentType: type.contentType, kind: type.kind, data };
    }
    if (data) reason = data.byteLength === 0 ? "empty" : "too_large";
    log("worker.cited_workspace_file_skipped", {
      runId: context.id,
      organizationId: context.organizationId,
      file: path,
      reason,
    }, "debug");
    return null;
  }));
  return resolved.filter((artifact): artifact is RuntimeArtifact => artifact !== null);
}
