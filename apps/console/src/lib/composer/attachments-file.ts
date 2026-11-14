/**
 * A browser `File` → the attachment we send.
 *
 * Split from `@openedbot/conversation/domain/attachments` for a types reason, not taste:
 * `File` and `FileReader` come from the DOM library, and the cloud API
 * compiles without it (`lib: ["ES2023"]`). Shared has nothing to
 * convert anyway: it receives attachments already read, bounds them and inlines them in the
 * prompt. This module is the PWA piece that reads the file.
 */

import {
  documentAttachment,
  imageAttachment,
  type AttachmentKind,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";

/**
 * Extensions treated as text when the system gives no MIME
 * type (the case of `.ts`, `.rs`, `.toml`… on macOS as on iOS, where the
 * picker returns `contentType: ""` or `application/octet-stream`).
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
  "ini", "conf", "env", "xml", "html", "css", "scss", "svg", "sql", "sh", "bash", "zsh", "fish",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "lua", "r", "dockerfile", "gitignore", "patch", "diff",
]);

/**
 * What we know how to do with a file, or `null`: a `null` is a named
 * refusal on the client side, never an attachment silently ignored.
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
 * A `File` → the attachment we send, in the EXACT shape the
 * assistant-ui adapters produce
 * (`@assistant-ui/core/dist/adapters/attachment.js`,
 * `SimpleImageAttachmentAdapter.send` and `SimpleTextAttachmentAdapter.send`):
 * a data-URI for an image, an `<attachment name=…>` for text.
 *
 * Why not import those classes here: pulling `@assistant-ui/core` and its
 * five peers (zustand, store, tap, assistant-cloud, assistant-stream) for
 * two ten-line methods. The shape is pinned by `composeRunInput` and
 * its tests: that is what must stay stable, not the import path.
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
 * `FileReader` first, `arrayBuffer()` as fallback: the same order as upstream
 * (`getFileDataURL`). Bun (hence our tests) does not always have `FileReader`;
 * the browser has both. Each environment takes the branch it has.
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
  // In slices: `String.fromCharCode(...bytes)` in one go overflows the call
  // stack past a few tens of thousands of bytes.
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
