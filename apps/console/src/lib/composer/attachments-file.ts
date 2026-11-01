/**
 * Un `File` du navigateur → la pièce jointe qu'on envoie.
 *
 * Séparé de `@openedbot/conversation/domain/attachments` pour une raison de types, pas de goût :
 * `File` et `FileReader` viennent de la bibliothèque DOM, et le cloud API
 * compile sans elle (`lib: ["ES2023"]`). Shared n'a de toute façon rien à
 * convertir : il reçoit des pièces déjà lues, les borne et les inline dans le
 * prompt. Ce module est le morceau PWA qui lit le fichier.
 */

import {
  documentAttachment,
  imageAttachment,
  type AttachmentKind,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";

/**
 * Extensions traitées comme du texte quand le système ne donne pas de type
 * MIME (le cas de `.ts`, `.rs`, `.toml`… sous macOS comme sous iOS, où le
 * sélecteur rend `contentType: ""` ou `application/octet-stream`).
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
  "ini", "conf", "env", "xml", "html", "css", "scss", "svg", "sql", "sh", "bash", "zsh", "fish",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "lua", "r", "dockerfile", "gitignore", "patch", "diff",
]);

/**
 * Ce qu'on sait faire d'un fichier, ou `null` : un `null` est un refus
 * nommé côté client, jamais une pièce silencieusement ignorée.
 */
export function attachmentKindFor(file: { name: string; type: string }): AttachmentKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/") || /^application\/(json|xml|x-yaml|toml)$/.test(file.type)) {
    return "document";
  }
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : file.name.toLowerCase();
  return TEXT_EXTENSIONS.has(extension) ? "document" : null;
}

/**
 * Un `File` → la pièce jointe qu'on envoie, dans la forme EXACTE que les
 * adaptateurs d'assistant-ui produisent
 * (`@assistant-ui/core/dist/adapters/attachment.js`,
 * `SimpleImageAttachmentAdapter.send` et `SimpleTextAttachmentAdapter.send`) :
 * un data-URI pour une image, un `<attachment name=…>` pour un texte.
 *
 * Pourquoi ne pas importer ces classes ici : tirer `@assistant-ui/core` et ses
 * cinq pairs (zustand, store, tap, assistant-cloud, assistant-stream) pour
 * deux méthodes de dix lignes. La forme est épinglée par `composeRunInput` et
 * ses tests : c'est elle qui doit rester stable, pas le chemin d'import.
 */
export async function attachmentFromFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<MessageAttachmentInput> {
  const kind = attachmentKindFor(file);
  if (!kind) throw new Error(`Type non pris en charge : ${file.name}`);
  if (kind === "image") {
    return imageAttachment(file.name, file.type, await readAsDataUrl(file, onProgress));
  }
  return documentAttachment(file.name, file.type, await readAsText(file, onProgress));
}

/** `FileReader` progress events as a 0..1 fraction: what the tile ring shows. */
function reportProgress(reader: FileReader, onProgress?: (fraction: number) => void): void {
  if (!onProgress) return;
  reader.onprogress = (event) => {
    if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
  };
}

/**
 * `FileReader` d'abord, `arrayBuffer()` en repli : le même ordre que l'amont
 * (`getFileDataURL`). Bun (donc nos tests) n'a pas toujours `FileReader` ;
 * le navigateur a les deux. Chaque environnement emprunte la branche qu'il a.
 */
async function readAsDataUrl(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  if (typeof FileReader === "undefined") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return `data:${file.type || "application/octet-stream"};base64,${toBase64(bytes)}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reportProgress(reader, onProgress);
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture impossible."));
    reader.readAsDataURL(file);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Par tranches : `String.fromCharCode(...bytes)` d'un coup déborde la pile
  // d'appels au-delà de quelques dizaines de milliers d'octets.
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

async function readAsText(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  if (typeof FileReader === "undefined") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reportProgress(reader, onProgress);
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture impossible."));
    reader.readAsText(file);
  });
}
