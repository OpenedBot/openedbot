import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertString } from "@openedbot/platform-config/http-body";
import { SECTION_CONTEXT_MAX_CHARS } from "./playbooks";
import { readSectionId } from "./section-id";

/** Le nom d'une section à créer. */
export function readSectionName(body: Record<string, unknown>): string {
  return assertString(body.name, "Le nom de la section", { max: 100 });
}

/** Un `PATCH /api/sections/:id` lu et validé : `null` veut dire « ne pas toucher ». */
export type SectionPatchInput = {
  name: string | null;
  collapsed: boolean | null;
  context: string | null;
  position: number | null;
};

export function readSectionPatch(body: Record<string, unknown>): SectionPatchInput {
  const context = Object.hasOwn(body, "context")
    ? (() => {
      if (typeof body.context !== "string") {
        throw new HttpError(400, "SECTION_CONTEXT_INVALID", "Le brief d’équipe doit être du texte.");
      }
      if (body.context.length > SECTION_CONTEXT_MAX_CHARS) {
        throw new HttpError(400, "SECTION_CONTEXT_TOO_LONG", `Le brief d’équipe dépasse ${SECTION_CONTEXT_MAX_CHARS} caractères.`);
      }
      return body.context;
    })()
    : null;
  return {
    name: typeof body.name === "string" ? body.name.trim().slice(0, 100) || null : null,
    collapsed: typeof body.collapsed === "boolean" ? body.collapsed : null,
    context,
    position: typeof body.position === "number" ? Math.floor(body.position) : null,
  };
}

const SECTION_ORDER_MAX = 500;

/** `{ order: [{ kind: "bot" | "group", id }] }` : des uuid, sans doublon, bornés. */
export function readSectionOrder(value: unknown): Array<{ kind: "bot" | "group"; id: string }> {
  if (!Array.isArray(value) || value.length > SECTION_ORDER_MAX) {
    throw new HttpError(400, "SECTION_ORDER_INVALID", "L'ordre demandé est invalide.");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new HttpError(400, "SECTION_ORDER_INVALID", "L'ordre demandé est invalide.");
    const { kind, id } = item as { kind?: unknown; id?: unknown };
    if (kind !== "bot" && kind !== "group") throw new HttpError(400, "SECTION_ORDER_INVALID", "L'ordre demandé est invalide.");
    const rowId = readSectionId(id);
    const key = `${kind}:${rowId}`;
    if (seen.has(key)) throw new HttpError(400, "SECTION_ORDER_INVALID", "L'ordre demandé est invalide.");
    seen.add(key);
    return { kind, id: rowId };
  });
}

/** `{ order: ["<sectionId>", …] }` : l'ordre des sections éditables, des uuid sans doublon. */
export function readSectionsOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > SECTION_ORDER_MAX) {
    throw new HttpError(400, "SECTIONS_ORDER_INVALID", "L'ordre des sections est invalide.");
  }
  const ids = value.map((item) => readSectionId(item));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "SECTIONS_ORDER_INVALID", "L'ordre des sections est invalide.");
  return ids;
}
