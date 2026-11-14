/** `API_MAX_BODY_BYTES`: 16 MiB by default, never above 64 MiB. */
export function readRequestBodyLimit(value: string | undefined): number {
  const limit = Number(value ?? 16 * 1024 * 1024);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024) {
    throw new Error("API_MAX_BODY_BYTES must be an integer between 1 and 67108864.");
  }
  return limit;
}
