import type { TransactionDb } from "@openedbot/platform-db";
import { hasPendingReplacement, lockRuntimeDeclarations } from "@openedbot/runtimes/sql/runtime-replacement";
import { HttpError } from "../../interfaces/http/http-error";

/**
 * Une organisation n'a qu'UN runtime. Un second n'existe que le temps d'un
 * remplacement : déclaré inactif, il attend `POST /:runtimeId/replace` ou son
 * retrait. Tant qu'il attend, on n'en déclare pas un troisième : deux
 * remplaçants côte à côte reconstruisaient le parc à bascule qu'on a retiré.
 *
 * Prend le verrou de déclaration de l'organisation : à appeler dans la
 * transaction qui insère, pour que le contrôle et l'insertion ne fassent qu'un.
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
