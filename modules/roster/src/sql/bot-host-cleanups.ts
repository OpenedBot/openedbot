import type { TransactionDb } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";

export type BotHostCleanupRow = {
  id: string;
  organization_id: string;
  bot_id: string;
  runtime_id: string;
  profile: string | null;
  session_profile: string | null;
  session_ids: string[];
  /** Deleted sessions whose host profile survives, re-read after a delay. */
  verify_session_ids: string[];
  verify_passes: number;
  /** A pass proved the host profile absent: later passes leave that name alone (0150). */
  profile_removed_at?: Date | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: Date | null;
};

export async function insertBotHostCleanup(tx: TransactionDb, input: {
  organizationId: string; botId: string; botDeletedAt: Date; runtimeId: string; profile: string | null;
  sessionProfile: string | null; sessionIds: string[];
}): Promise<void> {
  await tx`insert into bot_host_cleanups
    (organization_id, bot_id, bot_deleted_at, runtime_id, profile, session_profile, session_ids)
    values (${input.organizationId}, ${input.botId}, ${input.botDeletedAt}, ${input.runtimeId}, ${input.profile},
      ${input.sessionProfile}, ${pgTextArray(input.sessionIds)}::text[])`;
}
