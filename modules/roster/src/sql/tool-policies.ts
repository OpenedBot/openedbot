import type { SQL } from "bun";
import type { BotToolPolicyDto, BotToolPolicyWrite } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

type Queryable = SQL | TransactionDb;

/** The member who writes; the row records the actor kind `member`. */
export type ToolPolicyActor = { userId: string | null };

/**
 * The worker's policy on `bot_permission_tool_policies` (0141) is tenant
 * scoped: a read sets `app.organization_id` for itself inside the caller's
 * transaction, then puts the previous value back, so the rest of that
 * transaction (`persistEvents`) is unchanged. Without it the read would see
 * no row, which would lift a `block`: never call the table without it.
 */
export async function underTenant<T>(tx: Queryable, organizationId: string, read: () => Promise<T>): Promise<T> {
  const rows = await tx<Array<{ previous: string }>>`
    select coalesce(current_setting('app.organization_id', true), '') as previous
  `;
  const previous = rows[0]?.previous ?? "";
  await tx`select set_config('app.organization_id', ${organizationId}, true)`;
  try {
    return await read();
  } finally {
    await tx`select set_config('app.organization_id', ${previous}, true)`;
  }
}

/** The stored policy of one tool of one bot, `null` when it follows the mode. Must run inside a transaction. */
export async function readToolPolicyTx(tx: Queryable, organizationId: string, botId: string, toolKey: string): Promise<string | null> {
  return underTenant(tx, organizationId, async () => {
    const rows = await tx<Array<{ policy: string }>>`
      select policy from bot_permission_tool_policies
       where organization_id = ${organizationId} and bot_id = ${botId} and tool_key = ${toolKey}
    `;
    return rows[0]?.policy ?? null;
  });
}

/** The bot's blocked keys, sorted: the exact list the host profile must hold. Must run inside a transaction. */
export async function readBlockedToolsTx(tx: Queryable, organizationId: string, botId: string): Promise<string[]> {
  return underTenant(tx, organizationId, async () => {
    const rows = await tx<Array<{ toolKey: string }>>`
      select tool_key as "toolKey" from bot_permission_tool_policies
       where organization_id = ${organizationId} and bot_id = ${botId} and policy = 'block'
       order by tool_key collate "C"
    `;
    return rows.map((row) => row.toolKey);
  });
}

/** Opens its own transaction: for a caller that holds none (the worker's reconciliation). */
export async function readBlockedTools(db: SQL, organizationId: string, botId: string): Promise<string[]> {
  return db.begin((tx) => readBlockedToolsTx(tx, organizationId, botId)) as Promise<string[]>;
}

export async function readBotToolPolicies(tx: TransactionDb, organizationId: string, botId: string): Promise<BotToolPolicyDto[]> {
  const rows = await tx<Array<{ toolKey: string; policy: string; updatedAt: Date | string; updatedByKind: "member" }>>`
    select tool_key as "toolKey", policy, updated_at as "updatedAt", updated_by_kind as "updatedByKind"
      from bot_permission_tool_policies
     where organization_id = ${organizationId} and bot_id = ${botId} and policy <> 'inherit'
     order by tool_key collate "C"
  `;
  return rows.map((row) => ({
    toolKey: row.toolKey,
    // A value this build does not know is shown as what the pipeline does with it.
    policy: row.policy === "always" || row.policy === "block" ? row.policy : "ask",
    updatedAt: new Date(row.updatedAt).toISOString(),
    updatedByKind: row.updatedByKind,
  }));
}

/**
 * Applies a write: `inherit` removes the row, any other value upserts it. An
 * unchanged value is not rewritten, so it neither moves the actor nor the
 * bot's revision.
 */
export async function writeBotToolPolicies(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  entries: readonly BotToolPolicyWrite[],
  actor: ToolPolicyActor,
): Promise<void> {
  for (const entry of entries) {
    if (entry.policy === "inherit") {
      await tx`
        delete from bot_permission_tool_policies
         where organization_id = ${organizationId} and bot_id = ${botId} and tool_key = ${entry.toolKey}
      `;
      continue;
    }
    await tx`
      insert into bot_permission_tool_policies
        (organization_id, bot_id, tool_key, policy, updated_by_user_id, updated_by_kind)
      values (${organizationId}, ${botId}, ${entry.toolKey}, ${entry.policy}, ${actor.userId}, 'member')
      on conflict (organization_id, bot_id, tool_key) do update
        set policy = excluded.policy,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_by_kind = excluded.updated_by_kind,
            updated_at = now()
        where bot_permission_tool_policies.policy is distinct from excluded.policy
    `;
  }
}

export async function countBotToolPolicies(tx: TransactionDb, organizationId: string, botId: string): Promise<{ stored: number; blocked: number }> {
  const rows = await tx<Array<{ stored: number | string; blocked: number | string }>>`
    select count(*) filter (where policy <> 'inherit') as stored,
           count(*) filter (where policy = 'block') as blocked
      from bot_permission_tool_policies
     where organization_id = ${organizationId} and bot_id = ${botId}
  `;
  return { stored: Number(rows[0]?.stored ?? 0), blocked: Number(rows[0]?.blocked ?? 0) };
}
