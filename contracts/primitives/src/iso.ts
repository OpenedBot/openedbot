/** A `Date` or a string dated in ISO 8601; throws `RangeError` if the string is not a date. */
export function isoInstant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Like `isoInstant`, but a string that is not a date is returned as is. */
export function isoInstantLenient(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

/** `null` for any falsy value (`null`, empty string), otherwise `isoInstant`. */
export function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** `null` only for `null`: an empty string goes through `new Date("")` and throws. */
export function isoUnlessNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
