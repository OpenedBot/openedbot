import type { TransactionDb } from "@openedbot/platform-db";

export type ProfileProvisionRow = {
  bot_id: string;
  organization_id: string;
  runtime_id: string;
  slug: string;
  display_name: string;
  provider: string | null;
  model: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  host_create_attempted: boolean;
  host_profile_ownership: "unknown" | "ours" | "foreign";
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: Date | null;
  /** Database clock: creation, and the claim that returned this row (`updated_at`). */
  created_at?: Date;
  updated_at?: Date;
};

export async function insertProfileProvision(
  tx: TransactionDb,
  input: { botId: string; organizationId: string; runtimeId: string; slug: string; displayName: string; provider: string | null; model: string | null },
): Promise<void> {
  await tx`
    insert into bot_profile_provisions (bot_id, organization_id, runtime_id, slug, display_name, provider, model)
    values (${input.botId}, ${input.organizationId}, ${input.runtimeId}, ${input.slug}, ${input.displayName}, ${input.provider}, ${input.model})
  `;
}
