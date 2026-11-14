import { isUuid } from "@openedbot/contracts-primitives";
import { parseHostProfile, parseHostProfileAvatar } from "@openedbot/hermes";
import type { HermesBundleImportInput, HermesProfileImportEntry } from "@openedbot/contracts-api";
import { ProfileImportError } from "@openedbot/roster/domain/profile-errors";

const PROFILE_FIELDS = ["name", "displayName", "title", "description", "soul", "model", "uiMeta", "hasAvatar", "routines", "skills", "toolsets", "mcpServers", "avatar"];
const FLAG_PATTERNS = {
  toolsets: /^[a-z0-9][a-z0-9_]{0,63}$/,
  skills: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  mcpServers: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
};

export function parseHermesBundleInput(value: unknown): { input: HermesBundleImportInput; limitations: string[] } {
  const body = fields(value, ["profiles", "sectionId", "idempotencyKey"]);
  if (typeof body.idempotencyKey !== "string" || !isUuid(body.idempotencyKey)) invalid("idempotencyKey");
  if (body.sectionId !== undefined && (typeof body.sectionId !== "string" || !isUuid(body.sectionId))) invalid("sectionId");
  if (!Array.isArray(body.profiles) || !body.profiles.length) throw new ProfileImportError(400, "PROFILE_IMPORT_EMPTY", "Choisissez au moins un profil à importer.");
  if (body.profiles.length > 32) throw new ProfileImportError(400, "PROFILE_IMPORT_TOO_MANY", "Importez au maximum 32 profils à la fois.");
  const limitations: string[] = [];
  const seen = new Set<string>();
  const profiles = body.profiles.map((raw) => {
    const row = fields(raw, PROFILE_FIELDS);
    const slug = typeof row.name === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(row.name) ? row.name : "?";
    try {
      fields(row.model, ["default", "provider"]);
      if (row.uiMeta != null) fields(row.uiMeta, ["title", "color", "shape", "imageKind", "hidden", "pinned", "sectionId", "groups", "created"]);
      if (!Array.isArray(row.routines)) invalid(slug);
      for (const routine of row.routines) fields(routine, ["name", "schedule", "prompt", "enabled", "deliver", "model"]);
      for (const kind of ["toolsets", "skills", "mcpServers"] as const) {
        if (!Array.isArray(row[kind])) invalid(slug);
        const names = new Set<string>();
        for (const flag of row[kind] as unknown[]) {
          const item = fields(flag, ["name", "enabled"]);
          if (typeof item.name !== "string" || !FLAG_PATTERNS[kind].test(item.name) || names.has(item.name)) invalid(slug);
          names.add(item.name);
        }
      }
      const profile = parseHostProfile(row);
      if (seen.has(profile.name) || new TextEncoder().encode(profile.displayName).length > 120 || /[\x00-\x1f\x7f]/.test(profile.displayName)) invalid(slug);
      seen.add(profile.name);
      let avatar: HermesProfileImportEntry["avatar"] = null;
      if (row.avatar != null) {
        const image = fields(row.avatar, ["contentType", "base64"]);
        if (typeof image.contentType !== "string" || typeof image.base64 !== "string") invalid(slug);
        if (image.base64.length > 4 * Math.ceil((128 * 1024) / 3)) {
          limitations.push(`avatar-too-large:${slug}`);
        } else {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) invalid(slug);
          const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
          if (bytes.byteLength > 128 * 1024) limitations.push(`avatar-too-large:${slug}`);
          else {
            const parsed = parseHostProfileAvatar(image.contentType, bytes);
            if (!imageSignatureMatches(parsed.contentType, bytes)) invalid(slug);
            avatar = { contentType: parsed.contentType, base64: image.base64 };
          }
        }
      }
      return { ...profile, avatar } satisfies HermesProfileImportEntry;
    } catch (error) {
      if (error instanceof ProfileImportError) throw error;
      invalid(slug);
    }
  });
  return { input: { profiles, idempotencyKey: body.idempotencyKey as string, ...(body.sectionId ? { sectionId: body.sectionId as string } : {}) }, limitations };
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("?");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new ProfileImportError(400, "TEAM_IMPORT_FIELDS_INVALID", "L’import contient des champs non autorisés.");
  }
  return record;
}

function invalid(slug: string): never {
  throw new ProfileImportError(400, "PROFILE_BUNDLE_INVALID", `La configuration du profil « ${slug} » est invalide.`);
}

function imageSignatureMatches(type: string, bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (type === "image/png") return head.startsWith("\x89PNG\r\n\x1a\n");
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return head.startsWith("GIF87a") || head.startsWith("GIF89a");
  return type === "image/webp" && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
}
