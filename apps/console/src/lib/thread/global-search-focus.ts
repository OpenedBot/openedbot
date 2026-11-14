/** The `?focus=` of a global-search result: `message:`, `event:` or `run:` followed by an id, 200 characters at most. */
export function readGlobalSearchFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 && /^(?:message|event|run):/u.test(value)
    ? value
    : undefined;
}
