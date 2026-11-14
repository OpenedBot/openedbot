import type { TransactionalEmailKind } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";

/**
 * Déposer un e-mail dans la file durable (`email_outbox`).
 *
 * L'API dépose, le worker envoie : c'est la seule répartition qui survit à un
 * redémarrage entre les deux. Une requête HTTP ne parle jamais à un
 * fournisseur d'e-mail. Elle écrit une ligne, dans la même transaction que le
 * fait qui la justifie, et rend la main.
 *
 * `dedupeKey` est la clé d'unicité de la table : elle protège le rejeu d'un
 * même événement. Zéro ligne écrite n'est pas une erreur SQL, c'est la réponse
 * que l'appelant doit observer et journaliser.
 *
 * L'insertion ne lit RIEN, et c'est la contrainte qui la dessine : `openedbot_api`
 * dépose dans la file sans jamais pouvoir la relire (0064), or cette
 * file porte des adresses en clair jusqu'à l'envoi. D'où deux formes qui
 * sautent aux yeux :
 *
 * - `on conflict do nothing` SANS cible : nommer `dedupe_key` exigerait le
 *   `select` sur cette colonne. C'est la seule contrainte unique en dehors de
 *   la clé primaire, l'inférence désigne donc la même ;
 * - pas de `returning` : sous RLS, rendre une ligne insérée exige une
 *   politique `select`, que `openedbot_api` n'a pas. Le nombre de lignes écrites
 *   (`count`) dit la même chose sans rien lire.
 *
 * `payload` est passé en OBJET, pas en texte : le `SQL` de Bun sérialise
 * lui-même le paramètre vers `jsonb`, si bien qu'un `JSON.stringify` en amont
 * produit une CHAÎNE jsonb, que la contrainte `jsonb_typeof(payload) =
 * 'object'` de la table rejette (`0002_billing_tenant_ops.sql`).
 *
 * `kind` est borné par la contrainte SQL (`0064_email_outbox_api.sql`) et par
 * le rendu (`modules/notifications/src/domain/email/templates.ts`) : un genre
 * ajouté ici sans son gabarit part en échec de rendu, pas en e-mail vide.
 */
export type TransactionalEmailRequest = {
  kind: TransactionalEmailKind;
  dedupeKey: string;
  recipientEmail: string;
  locale: string;
  payload: Record<string, unknown>;
};

export async function enqueueTransactionalEmail(
  db: Db,
  request: TransactionalEmailRequest,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const written = await db`
    insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (
      ${id}, ${request.kind}, ${request.dedupeKey},
      ${request.recipientEmail}, ${request.locale}, ${request.payload}::jsonb
    )
    on conflict do nothing
  `;
  return written.count > 0 ? id : null;
}

export type TransactionalEmailEvent =
  | "queued"
  | "duplicate_skipped"
  | "sent"
  | "retry"
  | "failed"
  | "lease_lost";

type FlatEventDetail = string | number | boolean | null;

function emailDomainFromValue(value: string): string {
  const afterAt = value.slice(value.lastIndexOf("@") + 1).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*/u.exec(afterAt)?.[0]
    ?? "domaine-masque";
}

function safeEventDetail(detail: Record<string, unknown>): Record<string, FlatEventDetail> {
  const filtered: Record<string, FlatEventDetail> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key.includes("@")) continue;
    if (typeof value === "string") {
      filtered[key] = value.includes("@") ? emailDomainFromValue(value) : value;
      continue;
    }
    if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || value === null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Écrit un fait d'observation sans relire le journal.
 *
 * `detail` reste un objet passé TEL QUEL au paramètre `jsonb` : le sérialiser
 * avec `JSON.stringify` produirait une chaîne jsonb, refusée par la contrainte
 * `jsonb_typeof(detail) = 'object'`.
 *
 * Le filtrage est une garde, pas de la coquetterie : le journal est lu par du
 * les opérateurs et survit à l'effacement de l'adresse dans `email_outbox`. Seules les
 * valeurs plates passent. Toute chaîne contenant `@` devient son seul domaine.
 */
export async function recordTransactionalEmailEvent(db: Db, entry: {
  outboxId: string | null;
  kind: TransactionalEmailKind;
  event: TransactionalEmailEvent;
  attempt?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const detail = safeEventDetail(entry.detail ?? {});
  await db`
    insert into email_outbox_events (outbox_id, kind, event, attempt, detail)
    values (${entry.outboxId}, ${entry.kind}, ${entry.event}, ${entry.attempt ?? null}, ${detail}::jsonb)
  `;
}
