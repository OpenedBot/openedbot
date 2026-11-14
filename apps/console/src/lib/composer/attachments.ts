/**
 * What the composer does with a file before sending it (US-CHAT-08).
 *
 * Reading the `File` lives in `@/lib/composer/attachments-file`; the wrapping
 * (bounds, inline in the prompt) stays in `@openedbot/conversation/domain/attachments`.
 * Here we add the only gesture that belongs to the browser: SHRINK an image before
 * encoding it. Without that, the function would be honest but useless: a
 * Retina screenshot weighs 3 to 6 MB, more than the per-attachment ceiling,
 * and a photo exceeds every model's context window before the
 * question is even asked.
 */
import {
  ATTACHMENT_LIMITS,
  IMAGE_DOWNSCALE,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { attachmentFromFile, attachmentKindFor } from "@/lib/composer/attachments-file";

export type AttachmentError =
  | { code: "unsupported"; name: string }
  | { code: "too-large"; name: string; bytes: number }
  | { code: "too-many" }
  | { code: "unreadable"; name: string };

export type PrepareResult = {
  attachments: MessageAttachmentInput[];
  errors: AttachmentError[];
};

/**
 * Prepares a selection, keeping what passes and NAMING what does
 * not.
 *
 * A refused file does not cancel the others: dropping five screenshots of which one
 * is too heavy must attach the four and say which is missing, not reject
 * everything as a block. `existing` serves the count ceiling, which is counted on what
 * is ALREADY in the composer.
 */
export async function prepareAttachments(
  files: readonly File[],
  existing: number,
  /**
   * Real read progress of `files[index]`, 0..1 (FileReader `progress`). The
   * composer draws it as the tile's ring; nothing is simulated, a file that
   * reports nothing simply jumps from 0 to done.
   */
  onProgress?: (index: number, fraction: number) => void,
): Promise<PrepareResult> {
  const attachments: MessageAttachmentInput[] = [];
  const errors: AttachmentError[] = [];
  for (const [index, file] of files.entries()) {
    if (existing + attachments.length >= ATTACHMENT_LIMITS.maxCount) {
      errors.push({ code: "too-many" });
      break;
    }
    if (!attachmentKindFor(file)) {
      errors.push({ code: "unsupported", name: file.name });
      continue;
    }
    try {
      const prepared = await attachmentFromFile(
        await downscaleIfImage(file),
        onProgress && ((fraction) => onProgress(index, fraction)),
      );
      const bytes = payloadBytes(prepared);
      if (bytes > ATTACHMENT_LIMITS.maxBytesEach) {
        errors.push({ code: "too-large", name: file.name, bytes });
        continue;
      }
      attachments.push(prepared);
      onProgress?.(index, 1);
    } catch {
      errors.push({ code: "unreadable", name: file.name });
    }
  }
  return { attachments, errors };
}

/** The same measure as the server, on what has just been encoded. */
function payloadBytes(attachment: MessageAttachmentInput): number {
  let bytes = 0;
  for (const part of attachment.content) {
    if (part.type === "text") bytes += new TextEncoder().encode(part.text).length;
    else bytes += Math.floor((part.image.length - part.image.indexOf(",") - 1) * 0.75);
  }
  return bytes;
}

/**
 * Shrinks an image to `IMAGE_DOWNSCALE.maxEdge` on its longest side.
 *
 * Returns the ORIGINAL file as soon as shrinking fails, brings nothing, or
 * is not possible here (tests run under happy-dom, which has neither
 * `createImageBitmap` nor `canvas.toBlob`): better an attachment the
 * ceiling will refuse with a named reason than an attachment silently lost.
 */
async function downscaleIfImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, IMAGE_DOWNSCALE.maxEdge / longest);
    // Already small AND already under the ceiling: re-encoding it would only
    // degrade an image nobody needed to touch.
    if (scale === 1 && file.size <= ATTACHMENT_LIMITS.maxBytesEach) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_DOWNSCALE.quality),
    );
    // A flat-screen PNG sometimes comes out HEAVIER as JPEG: we then keep
    // the original, which is better AND smaller.
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** The name follows the format: a `.png` that became JPEG would lie about its content. */
function jpegName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}
