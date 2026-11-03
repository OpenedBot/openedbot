/** Le `?focus=` d'un résultat de la recherche globale : `message:`, `event:` ou `run:` suivi d'un id, 200 caractères au plus. */
export function readGlobalSearchFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 && /^(?:message|event|run):/u.test(value)
    ? value
    : undefined;
}
