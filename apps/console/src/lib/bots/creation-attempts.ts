import { randomId } from "../random-id";

/**
 * The `clientRequestId` of a bot creation (0135), tied to the request it was
 * minted for. Sending the SAME request again (double submit, retry after a
 * lost answer) reuses the id, so the server answers the bot already created.
 * Any edit in between (another name, another persona) mints a new id: the
 * server binds an id to its body (0136) and would refuse the edited request,
 * and replaying the first bot would open one that does not match the form.
 */
export type CreationAttempts = {
  /** The id for this request content: the previous one if nothing changed. */
  idFor: (content: unknown) => string;
  /** A new creation starts (sheet reopened, bot created): forget the last attempt. */
  reset: () => void;
};

function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export function creationAttempts(mint: () => string = randomId): CreationAttempts {
  let last: { key: string; id: string } | null = null;
  return {
    idFor(content) {
      const key = stableKey(content);
      if (last?.key === key) return last.id;
      last = { key, id: mint() };
      return last.id;
    },
    reset() {
      last = null;
    },
  };
}
