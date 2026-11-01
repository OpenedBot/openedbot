import type { ProductFeatureAudience } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";

/**
 * Every persisted product switch, keyed by `feature_key`. The table is owned
 * by `staff` (the backoffice switches); the core reads it as the override
 * layer of its entitlements and writes only the boot defaults below.
 */
export async function readProductFeatureRows(db: Db): Promise<Array<{ featureKey: string; enabled: boolean; audience?: ProductFeatureAudience }>> {
  return db<Array<{ featureKey: string; enabled: boolean; audience?: ProductFeatureAudience }>>`
    select feature_key as "featureKey", enabled, audience from product_features
  `;
}

/**
 * Writes a boot default without overriding a choice made by staff
 * (`staff_override`). The only core write to `product_features`, declared in
 * `db/ownership.json`: solo has no backoffice, and still needs its defaults.
 */
export async function seedProductFeatureDefault(db: Db, key: string, enabled: boolean): Promise<void> {
  await db`
    insert into product_features (feature_key, enabled, staff_override)
    values (${key}, ${enabled}, false)
    on conflict (feature_key) do update
      set enabled = excluded.enabled, updated_at = now()
      where product_features.staff_override = false
        and product_features.enabled is distinct from excluded.enabled
  `;
}
