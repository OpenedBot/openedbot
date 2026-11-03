import { isoInstant } from "@openedbot/contracts-primitives";
import {
  effectiveBotPermission,
  yoloPolicyBlock,
  type BotPermissionMode,
  type EffectivePermission,
  type EffectiveYolo,
} from "@openedbot/contracts-api";
import { readBotCoverYoloLeasesTx } from "@openedbot/execution/sql/yolo-leases";
import { readOrganizationPermissionPolicy } from "@openedbot/identity/sql/permission-policy";
import { readReviewProven } from "@openedbot/runtimes/sql/review-profiles";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { readPermissionPipeline } from "../sql/bots";

/**
 * Le mode dans lequel chaque bot tourne vraiment, la règle qui l'a abaissé
 * (plafond, revue imposée, revue non prouvée) et le bail YOLO qui le couvre :
 * la rétrogradation est dite par le serveur, plus devinée par la console.
 * Le bail n'est rendu que là où la porte l'honore (hors plan, sans plafond
 * sous `bypass` ni revue imposée) ; un bail de bot l'emporte sur celui du
 * runtime.
 */
export async function withEffectivePermissions<T extends { id: string; permissionMode?: BotPermissionMode }>(
  db: Db,
  organizationId: string,
  bots: readonly T[],
): Promise<Array<T & { effectivePermission: EffectivePermission }>> {
  return withTenant(db, organizationId, async (tx) => {
    const pipeline = await readPermissionPipeline(tx, organizationId);
    const policy = await readOrganizationPermissionPolicy(tx, organizationId);
    const reviewProven = pipeline === "v2" ? await readReviewProven(tx, organizationId) : false;
    const leases = await readBotCoverYoloLeasesTx(tx, organizationId);
    const context = { pipeline, maxMode: policy?.maxMode ?? null, enforceReview: policy?.enforceReview ?? false, reviewProven };
    const honored = yoloPolicyBlock(context) === null;
    const cover = (botId: string): EffectiveYolo | null => {
      const lease = leases.find((row) => row.scope === "bot" && row.botId === botId) ?? leases.find((row) => row.scope === "runtime");
      return lease ? { leaseId: lease.id, scope: lease.scope, expiresAt: isoInstant(lease.expiresAt) } : null;
    };
    return bots.map((bot) => {
      const mode = bot.permissionMode ?? "manual";
      return { ...bot, effectivePermission: effectiveBotPermission(mode, context, honored && mode !== "plan" ? cover(bot.id) : null) };
    });
  });
}
