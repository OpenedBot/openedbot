import type { ProductFeatureAudience } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";

/** One stored flag (plan 0005): a switch per environment and the production audience. */
export type ProductFeatureRow = { featureKey: string; dev: boolean; prod: boolean; audience: ProductFeatureAudience };

/**
 * Every persisted product switch, keyed by `feature_key`. The table is owned
 * outside the core (the back office switches them); the core only reads it, as the
 * override layer of its entitlements. Defaults come from migrations.
 *
 * The column only holds `off`, `staff` (assisted sessions only) or `all` (0180);
 * anything else reads as `assisted`, the most restrictive audience.
 */
export async function readProductFeatureRows(db: Db): Promise<ProductFeatureRow[]> {
  const rows = await db<Array<{ featureKey: string; dev: boolean; prod: boolean; audience: string }>>`
    select feature_key as "featureKey", dev, prod, audience from product_features
  `;
  return rows.map((row) => ({ ...row, audience: knownAudience(row.audience) }));
}

function knownAudience(value: string): ProductFeatureAudience {
  // The stored value of an assisted-sessions-only audience is `staff` (0180).
  // Anything unknown reads as that most restrictive audience, never as open.
  return value === "off" || value === "all" ? value : "assisted";
}
