/**
 * Ce que le composer fait d'un fichier avant de l'envoyer (US-CHAT-08).
 *
 * La lecture du `File` vit dans `@/lib/attachments-file` ; l'emballage
 * (bornes, inline dans le prompt) reste dans `@openedbot/conversation/domain/attachments`.
 * Ici on ajoute le seul geste propre au navigateur : RÉDUIRE une image avant
 * de l'encoder. Sans lui, la fonction serait honnête mais inutile : une
 * capture d'écran Retina pèse 3 à 6 Mo, soit plus que le plafond par pièce,
 * et une photo dépasse la fenêtre de contexte de tout modèle avant même
 * d'avoir posé la question.
 */
import {
  ATTACHMENT_LIMITS,
  IMAGE_DOWNSCALE,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { attachmentFromFile, attachmentKindFor } from "@/lib/attachments-file";

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
 * Prépare une sélection, en gardant ce qui passe et en NOMMANT ce qui ne
 * passe pas.
 *
 * Un fichier refusé n'annule pas les autres : déposer cinq captures dont une
 * trop lourde doit joindre les quatre et dire laquelle manque, pas tout
 * rejeter en bloc. `existing` sert le plafond de nombre, qui se compte sur ce
 * qui est DÉJÀ dans le composer.
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

/** La même mesure que le serveur, sur ce qui vient d'être encodé. */
function payloadBytes(attachment: MessageAttachmentInput): number {
  let bytes = 0;
  for (const part of attachment.content) {
    if (part.type === "text") bytes += new TextEncoder().encode(part.text).length;
    else bytes += Math.floor((part.image.length - part.image.indexOf(",") - 1) * 0.75);
  }
  return bytes;
}

/**
 * Réduit une image à `IMAGE_DOWNSCALE.maxEdge` sur son plus grand côté.
 *
 * Rend le fichier D'ORIGINE dès que la réduction échoue, n'apporte rien, ou
 * n'est pas possible ici (les tests tournent sous happy-dom, qui n'a ni
 * `createImageBitmap` ni `canvas.toBlob`) : mieux vaut une pièce que le
 * plafond refusera avec un motif nommé qu'une pièce silencieusement perdue.
 */
async function downscaleIfImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, IMAGE_DOWNSCALE.maxEdge / longest);
    // Déjà petite ET déjà sous le plafond : la ré-encoder ne ferait que
    // dégrader une image que personne n'avait besoin de toucher.
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
    // Un PNG d'écran plat ressort parfois PLUS lourd en JPEG : on garde alors
    // l'original, qui est meilleur ET plus petit.
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Le nom suit le format : un `.png` devenu JPEG mentirait sur son contenu. */
function jpegName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}
