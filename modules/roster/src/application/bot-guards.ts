import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { TransactionDb } from "@openedbot/platform-db";
import type { BotRuns } from "./bot-runs";
import { assertBotProfileSettled } from "./profile-provisions";
import { hasPendingBotIngress, isBotInGroup, lockActiveBotRuns, lockBotRow, readActiveBotRuns } from "../sql/bots";

/*
  Les gardes communes à l'archivage, à la purge et au changement de machine
  d'un bot : aucun run actif, aucun salon (sauf détachement voulu), aucun
  message idempotent en cours.
*/

/**
 * Les conditions communes au soft delete et à la purge : inchangées depuis la
 * suppression en un temps, et rejouées à CHAQUE transaction de la purge :
 * entre la lecture des sessions et l'effacement de la ligne, il y a un aller
 * réseau vers le runtime, largement de quoi qu'un run démarre.
 *
 * Ne dit rien du bot inexistant : l'appelant le distingue par le nombre de
 * lignes que sa propre requête renvoie. `detachGroups` : la purge forcée détache
 * ses salons dans la même transaction ; leurs missions, lues avant, restent gardées.
 */
export async function assertBotDeletable(
  tx: TransactionDb,
  runs: BotRuns,
  organizationId: string,
  botId: string,
  options: { detachGroups?: boolean } = {},
): Promise<void> {
  await assertBotProfileSettled(tx, organizationId, botId);
  await assertBotQuiescent(tx, runs, organizationId, botId, {
    code: "CANCELLED_BY_DELETE",
    message: "Passe de maintenance annulée : le bot est supprimé.",
  }, "Ce bot exécute encore une mission. Arrêtez-la avant de supprimer le bot.", options.detachGroups === true);
}

/**
 * Un membre ne peut pas disparaître sous un salon : cela pourrait laisser un
 * groupe sous sa taille minimale et, surtout, un `default_responder` pilote
 * pointant vers un bot inactif. Le verrou fort du bot est déjà acquis par les
 * deux appelants. Les ajouts de membres prennent `FOR KEY SHARE` sur ce même
 * bot ; une création concurrente est donc soit visible ici, soit revalidée
 * après notre commit et refusée parce que le bot est désormais archivé.
 */
async function assertBotNotInGroup(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<void> {
  if (await isBotInGroup(tx, organizationId, botId)) {
    throw new HttpError(
      409,
      "BOT_IN_GROUP",
      "Retirez ce bot de ses salons ou choisissez un autre pilote avant de l’archiver ou de le supprimer.",
    );
  }
}

/**
 * Un run racine ou de salon en cours bloque l'archivage et la purge. Une passe
 * de maintenance (`memory`, `compaction`) est annulée, puis on continue.
 */
export async function assertBotQuiescent(
  tx: TransactionDb,
  runs: BotRuns,
  organizationId: string,
  botId: string,
  maintenanceReason: { code: string; message: string },
  busyMessage: string,
  allowGroups = false,
): Promise<boolean> {
  const active = await lockActiveBotRuns(tx, organizationId, botId);
  if (!(await lockBotRow(tx, organizationId, botId))) return false;
  const remaining = await runs.stopMaintenanceRuns(tx, organizationId, active, maintenanceReason);
  const blocking = remaining[0] ?? (await readActiveBotRuns(tx, organizationId, botId))[0];
  if (blocking) {
    throw new HttpError(
      409,
      "BOT_BUSY",
      busyMessage,
      {},
      { runId: blocking.id, stepKind: blocking.stepKind ?? null },
    );
  }
  if (!allowGroups) await assertBotNotInGroup(tx, organizationId, botId);
  if (await hasPendingBotIngress(tx, organizationId, botId)) {
    throw new HttpError(409, "BOT_SUBMISSION_IN_PROGRESS", "Un message idempotent est encore en cours ou en quarantaine.");
  }
  return true;
}
