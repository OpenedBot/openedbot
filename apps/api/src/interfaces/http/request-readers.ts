/** The secret of an `Authorization: Bearer <secret>` header, otherwise `null`. */
export function readBearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
  return match?.[1] ?? null;
}
