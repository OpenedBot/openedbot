/** A non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The object itself, or `null` when the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A non-empty string, otherwise `null`. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
