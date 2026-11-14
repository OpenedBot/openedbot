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
 * relais, vérifiée ici avant l'aller réseau.
 */
export const WORKSPACE_FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(png|jpg|jpeg|webp|pdf)$/;

export const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
const WORKSPACE_FILE_TIMEOUT_MS = 20_000;

const WORKSPACE_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

export type HermesWorkspaceFile = {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
  bytes: Uint8Array;
};

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
  if (!WORKSPACE_FILE_TYPES.has(contentType) || bytes.byteLength === 0 || bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw invalidProviderResponse();
  }
  return { contentType: contentType as HermesWorkspaceFile["contentType"], bytes };
}
