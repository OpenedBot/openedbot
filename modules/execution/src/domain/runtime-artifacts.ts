/**
 * Fichiers monstrables produits pendant un tour Hermes.
 *
 * Le SSE ne porte ni les arguments d'un outil ni son résultat
 * (`hermes-events.ts`). Le transcript de session, lui, garde les `tool_calls`
 * complets : c'est le même canal que le plan `todo` et les recherches web.
 *
 * On ne lit que les outils d'écriture dont l'argument porte ENCORE le contenu
 * (`write_file`). Un `search_replace` n'a que le diff : sans lecture du disque
 * du runtime (le connecteur n'en a aucune), le fichier ne devient pas une
 * puce. Pas de scan de `/root`.
 *
 * Format amont, mesuré sur `tools/file_tools.py` de NousResearch/hermes-agent :
 * `write_file` prend `{ path, content }`. Les alias (`file_path`, `Write`)
 * couvrent les formes OpenAI-compatibles et les clones Claude.
 */

import { asRecord } from "@openedbot/contracts-primitives";
import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { readAgentToolCall } from "./agent-tool-call";

/** Les outils dont l'argument EST le fichier, pas un diff. */
const WRITE_TOOLS = new Set(["write_file", "write", "Write", "create_file"]);

const VIEWABLE_BY_EXTENSION: Readonly<Record<string, { contentType: string; kind: "image" | "document" }>> = {
  ".html": { contentType: "text/html", kind: "document" },
  ".htm": { contentType: "text/html", kind: "document" },
  ".png": { contentType: "image/png", kind: "image" },
  ".jpg": { contentType: "image/jpeg", kind: "image" },
  ".jpeg": { contentType: "image/jpeg", kind: "image" },
  ".webp": { contentType: "image/webp", kind: "image" },
  ".pdf": { contentType: "application/pdf", kind: "document" },
};

export type RuntimeArtifact = {
  path: string;
  name: string;
  contentType: string;
  kind: "image" | "document";
  data: Uint8Array;
};

type JsonRecord = Record<string, unknown>;

function parseArguments(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * Secrets, clés, et magasins que le worker n'a pas le droit de recopier
 * dans les pièces jointes, même si l'outil d'écriture les a nommés.
 */
export function isSensitiveRuntimePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const name = basename(normalized);
  if (/(^|\/)\.env(\.|$|\/)/i.test(normalized)) return true;
  if (/^\.env/i.test(name)) return true;
  if (/(^|\/)\.git(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)\.ssh(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)\.hermes(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)(secrets?|credentials)(\/|$)/i.test(normalized)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return true;
  return /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.|$)/i.test(name);
}

function isTraversablePath(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

function viewableOf(path: string): { contentType: string; kind: "image" | "document" } | null {
  return VIEWABLE_BY_EXTENSION[extensionOf(basename(path))] ?? null;
}

function decodeArtifactBytes(content: string, contentType: string): Uint8Array | null {
  const dataUrl = /^data:([^,;]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i.exec(content.trim());
  if (dataUrl) return decodeBase64(dataUrl[2]!);
  const binaryType = contentType.startsWith("image/") || contentType === "application/pdf";
  if (binaryType && isBareBase64(content)) return decodeBase64(content.trim());
  return new TextEncoder().encode(content);
}

function isBareBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function readWriteCall(call: unknown): { path: string; content: string } | null {
  const record = asRecord(call);
  if (!record) return null;
  const normalized = readAgentToolCall(record);
  if (!normalized || !WRITE_TOOLS.has(normalized.name)) return null;
  const args = parseArguments(normalized.arguments);
  if (!args) return null;
  const path = readString(args, ["path", "file_path", "filename", "file"]);
  const content = readString(args, ["content", "contents", "text", "new_content"]);
  if (!path || content === null) return null;
  return { path: path.trim(), content };
}

/**
 * Rejoue les écritures du transcript, dernière occurrence d'un chemin gagnante.
 *
 * Un appel sans contenu, un chemin sensible, un type hors liste ou un fichier
 * trop gros n'existent pas : mieux vaut une puce absente qu'une pièce
 * corrompue ou secrète.
 */
export function projectRuntimeArtifacts(messages: unknown): RuntimeArtifact[] {
  if (!Array.isArray(messages)) return [];
  const byPath = new Map<string, RuntimeArtifact>();

  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.role !== "assistant") continue;
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    for (const call of calls) {
      const write = readWriteCall(call);
      if (!write) continue;
      if (isTraversablePath(write.path) || isSensitiveRuntimePath(write.path)) continue;
      const viewable = viewableOf(write.path);
      if (!viewable) continue;
      const data = decodeArtifactBytes(write.content, viewable.contentType);
      if (!data || data.byteLength === 0) continue;
      if (data.byteLength > ATTACHMENT_LIMITS.maxBytesEach) continue;
      const key = write.path.replace(/\\/g, "/");
      byPath.set(key, {
        path: key,
        name: basename(key),
        contentType: viewable.contentType,
        kind: viewable.kind,
        data,
      });
    }
  }

  const artifacts: RuntimeArtifact[] = [];
  let total = 0;
  for (const artifact of byPath.values()) {
    if (artifacts.length >= ATTACHMENT_LIMITS.maxCount) break;
    if (total + artifact.data.byteLength > ATTACHMENT_LIMITS.maxBytesTotal) continue;
    artifacts.push(artifact);
    total += artifact.data.byteLength;
  }
  return artifacts;
}
