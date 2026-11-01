/** Un objet non nul qui n'est pas un tableau. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** L'objet lui-même, ou `null` quand la valeur n'en est pas un. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Une chaîne non vide, sinon `null`. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
