import {
  PERMISSION_RULE_KINDS,
  PERMISSION_RULE_MAX_CHARS,
  type PermissionRuleInput,
  type PermissionRuleKind,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { collapseWhitespace, redactSecrets } from "./tool-text";

/**
 * PERM2-6: the stored form of a rule. One line (control characters removed,
 * whitespace collapsed), secrets masked, at most 1 000 characters after
 * masking: the form the `text` check of 0145 accepts, and the one the
 * duplicate index compares (case ignored). `null` when nothing is left.
 */
export function normalizePermissionRuleText(raw: string): string | null {
  const text = collapseWhitespace(redactSecrets(raw));
  if (!text || text.length > PERMISSION_RULE_MAX_CHARS) return null;
  return text;
}

/** The body of `POST /api/pro/permissions/.../rules` (plug-in `permissions`): `{ kind, text }`. */
export function readPermissionRuleInput(body: Record<string, unknown>): PermissionRuleInput {
  const kind = body.kind;
  if (typeof kind !== "string" || !(PERMISSION_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, "PERMISSION_RULE_INVALID", "Le type de règle est inconnu.", {}, { field: "kind" });
  }
  // Bounded before any work: a huge body is refused, not scanned.
  const raw = typeof body.text === "string" && body.text.length <= PERMISSION_RULE_MAX_CHARS * 4 ? body.text : null;
  const text = raw === null ? null : normalizePermissionRuleText(raw);
  if (text === null) {
    throw new HttpError(400, "PERMISSION_RULE_INVALID", `Une règle fait entre 1 et ${PERMISSION_RULE_MAX_CHARS} caractères.`, {}, { field: "text" });
  }
  return { kind: kind as PermissionRuleKind, text };
}
