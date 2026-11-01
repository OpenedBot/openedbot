import type { TransactionalEmailKind } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";

/**
 * Dépose un e-mail dans `email_outbox` et dit si la ligne est nouvelle
 * (`on conflict (dedupe_key) do nothing returning id`). Variante de
 * `enqueueTransactionalEmail` pour les appelants dont le rôle relit la file.
 */
export async function enqueueEmailReturningId(
  db: Db,
  input: {
    kind: TransactionalEmailKind;
    dedupeKey: string;
    recipientEmail: string;
    locale: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    insert into email_outbox (
      id, kind, dedupe_key, recipient_email, locale, payload
    ) values (
      ${crypto.randomUUID()}, ${input.kind},
      ${input.dedupeKey},
      ${input.recipientEmail}, ${input.locale},
      ${input.payload}
    )
    on conflict (dedupe_key) do nothing
    returning id
  `;
  return Boolean(rows[0]);
}
