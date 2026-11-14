import type { SQL } from "bun";
import { ATTACHMENT_LIMITS, attachmentChips, type LoadedAttachment, type AttachmentGap } from "@openedbot/conversation/domain/attachments";
import { readThreadAttachmentRows } from "@openedbot/conversation/application/attachments";
import { getArtifactBlob } from "../artifact-store";
import type { WorkerConfig } from "../worker-config";
import type { RoomLine } from "./room-lines";

/**
 * Relit les pièces nommées par les lignes du salon.
 *
 * Current and explicitly quoted files have priority. Historical documents
 * use the remaining per-turn budget; omitted files remain visible as gaps.
 */
export async function loadRoomAttachments(
  db: SQL,
  organizationId: string,
  threadId: string,
  unread: readonly RoomLine[],
  before: readonly RoomLine[],
  blob: WorkerConfig["blob"] | undefined,
): Promise<Map<string, LoadedAttachment | AttachmentGap>> {
  const wanted: string[] = [];
  const seen = new Set<string>();
  // Only unread messages and their explicit reply targets may load pixels.
  // Other old images remain notes; documents may fill the remaining budget.
  const take = (lines: readonly RoomLine[], withImages: boolean) => {
    for (const line of lines) {
      for (const chip of attachmentChips(line.content)) {
        if ((chip.kind === "image" && !withImages) || seen.has(chip.id)) continue;
        seen.add(chip.id);
        wanted.push(chip.id);
      }
    }
  };
  take(unread, true);
  take(unread.filter((line) => line.replyTarget).map((line) => ({ ...line, content: line.replyTarget!.content })), true);
  const asked = new Set(wanted);
  take([...before].reverse(), false);
  const files = new Map<string, LoadedAttachment | AttachmentGap>();
  if (wanted.length === 0) return files;
  const rows = await readThreadAttachmentRows(db, organizationId, threadId, wanted);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let spent = 0;
  let count = 0;
  for (const id of wanted) {
    const row = byId.get(id);
    const current = asked.has(id);
    if (!row || !blob) {
      files.set(id, current ? "missing" : "skipped");
      continue;
    }
    const bytes = Number(row.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > ATTACHMENT_LIMITS.maxBytesEach
      || count >= ATTACHMENT_LIMITS.maxCount || spent + bytes > ATTACHMENT_LIMITS.maxBytesTotal) {
      files.set(id, "skipped");
      continue;
    }
    const data = await getArtifactBlob(blob, row.objectKey, ATTACHMENT_LIMITS.maxBytesEach);
    if (!data) {
      files.set(id, "missing");
      continue;
    }
    if (data.byteLength !== bytes || data.byteLength > ATTACHMENT_LIMITS.maxBytesEach
      || spent + data.byteLength > ATTACHMENT_LIMITS.maxBytesTotal) {
      files.set(id, "skipped");
      continue;
    }
    count++;
    spent += data.byteLength;
    files.set(id, {
      name: row.name,
      contentType: row.contentType,
      kind: row.kind === "image" ? "image" : "document",
      data,
    });
  }
  return files;
}
