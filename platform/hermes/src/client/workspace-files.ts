import { PROFILE_SLUG_PATTERN } from "../contracts";
import { HermesClientError } from "../errors";
import { invalidProviderResponse } from "../parsers/shared";
import type { HermesClientContext } from "./context";

/**
 * Un fichier qu'un bot a fabriqué dans le `/workspace` de son bac à sable et
 * désigné par une ligne `MEDIA:` (route hôte `workspace_files.go`). Le
 * `/v1/runs` de Hermes ne l'intègre pas à la réponse, contrairement à ses
 * routes de chat : le worker le lit ici pour le joindre au message.
 *
 * Un NOM à la racine, jamais un chemin : même grammaire que l'allowlist du
 * relais, vérifiée ici avant l'aller réseau. Une image ou un PDF prend le
 * type que l'hôte lit dans ses octets ; un fichier texte (Markdown, texte,
 * CSV, JSON, HTML) doit revenir avec le type de son extension.
 */
export const WORKSPACE_FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(png|jpg|jpeg|webp|pdf|md|markdown|txt|csv|json|html|htm)$/;

export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const WORKSPACE_FILE_TIMEOUT_MS = 20_000;

const BINARY_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;

const TEXT_TYPE_BY_EXTENSION = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
} as const;

type TextType = (typeof TEXT_TYPE_BY_EXTENSION)[keyof typeof TEXT_TYPE_BY_EXTENSION];

export type HermesWorkspaceFile = {
  contentType: (typeof BINARY_TYPES)[number] | TextType;
  bytes: Uint8Array;
};

/** `notes.md` → `text/markdown` ; une image ou un PDF → `null`. */
function expectedTextType(name: string): TextType | null {
  const extension = name.slice(name.lastIndexOf(".") + 1) as keyof typeof TEXT_TYPE_BY_EXTENSION;
  return TEXT_TYPE_BY_EXTENSION[extension] ?? null;
}

export async function hostWorkspaceFile(ctx: HermesClientContext, name: string): Promise<HermesWorkspaceFile> {
  if (!WORKSPACE_FILE_NAME_PATTERN.test(name)) {
    throw new HermesClientError("Le nom de fichier du workspace est invalide.", 400, "NAME_INVALID");
  }
  if (ctx.profile && (!PROFILE_SLUG_PATTERN.test(ctx.profile) || ctx.profile === "default")) {
    throw new HermesClientError("Le profil du workspace est invalide.", 400, "PROFILE_INVALID");
  }
  // Host requests strip /p/<slug>; bind the owner in the host route itself.
  // An older host may refuse this path, but must never serve a shared file.
  const path = ctx.profile
    ? `/hermes-setup/profiles/${encodeURIComponent(ctx.profile)}/workspace/files/${name}`
    : `/hermes-setup/workspace/files/${name}`;
  const response = await ctx.hostRequest(
    path,
    { method: "GET" },
    "safe",
    WORKSPACE_FILE_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const textType = expectedTextType(name);
  const typed = textType
    ? contentType === textType
    : (BINARY_TYPES as readonly string[]).includes(contentType);
  if (!typed || bytes.byteLength === 0 || bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw invalidProviderResponse();
  }
  return { contentType: contentType as HermesWorkspaceFile["contentType"], bytes };
}
