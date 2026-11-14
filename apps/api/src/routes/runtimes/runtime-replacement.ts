import type { TransactionDb } from "@openedbot/platform-db";
import { hasPendingReplacement, lockRuntimeDeclarations } from "@openedbot/runtimes/application/runtime-replacement";
import { HttpError } from "../../interfaces/http/http-error";

/**
 * An organization has only ONE runtime. A second exists only for the duration of a
 * replacement: declared inactive, it waits for `POST /:runtimeId/replace` or its
 * removal. While it waits, a third is not declared: two
 * replacements side by side would bring back the runtime toggle that was removed.
 *
 * Takes the organization's declaration lock: call it inside the
 * transaction that inserts, so the check and the insert are one.
 */
export async function assertNoPendingReplacement(tx: TransactionDb, organizationId: string): Promise<void> {
  await lockRuntimeDeclarations(tx, organizationId);
  if (await hasPendingReplacement(tx, organizationId)) {
    throw new HttpError(
      409,
      "RUNTIME_REPLACEMENT_PENDING",
      "Un runtime attend déjà de remplacer l’actuel : terminez ce remplacement ou retirez-le d’abord.",
    );
  }
}
