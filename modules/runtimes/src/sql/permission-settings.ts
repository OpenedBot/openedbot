import type { SQL } from "bun";

/**
 * PERM2-4, D-3 (0140): the runtime switch "dangerous commands: always
 * allow". It counts only for the organization's active runtime (one at most,
 * 0013). The API writes; the worker only reads, tenant-scoped, and every
 * query filters `organization_id` explicitly.
 */
/** The member who writes; the row records the actor kind `member`. */
export type RuntimePermissionActor = { userId: string };

export type RuntimePermissionSettingsRow = {
  runtimeId: string;
  terminalDangerAlways: boolean;
  updatedAt: Date | string | null;
  updatedByKind: "member" | null;
  updatedByName: string | null;
};

export async function readTerminalAlwaysTx(tx: SQL, organizationId: string): Promise<boolean> {
  const rows = await tx<Array<{ switched: boolean }>>`
    select exists (
      select 1 from runtime_permission_settings s
        join runtimes r on r.organization_id = s.organization_id and r.id = s.runtime_id
       where s.organization_id = ${organizationId}
         and r.is_active and r.revoked_at is null
         and s.terminal_danger_always
    ) as switched
  `;
  return rows[0]?.switched === true;
}

/** The organization's active runtime, the one a gate of any of its bots runs on. */
export async function activeRuntimeIdTx(tx: SQL, organizationId: string): Promise<string | null> {
  const rows = await tx<Array<{ id: string }>>`
    select id from runtimes
     where organization_id = ${organizationId} and is_active and revoked_at is null
     limit 1
  `;
  return rows[0]?.id ?? null;
}

/** `null`: the runtime is not this organization's. A runtime never set reads `false`. */
export async function readRuntimePermissionSettingsTx(
  tx: SQL,
  organizationId: string,
  runtimeId: string,
): Promise<RuntimePermissionSettingsRow | null> {
  const rows = await tx<RuntimePermissionSettingsRow[]>`
    select r.id as "runtimeId", coalesce(s.terminal_danger_always, false) as "terminalDangerAlways",
           s.updated_at as "updatedAt", s.updated_by_kind as "updatedByKind",
           coalesce(nullif(u.display_name, ''), u.email) as "updatedByName"
      from runtimes r
      left join runtime_permission_settings s on s.organization_id = r.organization_id and s.runtime_id = r.id
      left join users u on u.id = s.updated_by_user_id
     where r.organization_id = ${organizationId} and r.id = ${runtimeId} and r.revoked_at is null
  `;
  return rows[0] ?? null;
}

/**
 * Sets the switch. Idempotent: writing the value already stored changes
 * nothing, so the bots' revision moves only on a real change (trigger).
 * `null`: the runtime is not this organization's (or is revoked).
 */
export async function setTerminalDangerAlwaysTx(
  tx: SQL,
  input: { organizationId: string; runtimeId: string; value: boolean; actor: RuntimePermissionActor },
): Promise<{ id: string; changed: boolean } | null> {
  const runtimes = await tx<Array<{ id: string }>>`
    select id from runtimes
     where organization_id = ${input.organizationId} and id = ${input.runtimeId} and revoked_at is null
  `;
  if (!runtimes[0]) return null;
  const rows = await tx<Array<{ id: string; changed: boolean }>>`
    insert into runtime_permission_settings (
      runtime_id, organization_id, terminal_danger_always,
      updated_by_user_id, updated_by_kind
    ) values (
      ${input.runtimeId}, ${input.organizationId}, ${input.value},
      ${input.actor.userId}, 'member'
    )
    on conflict (runtime_id) do update
       set terminal_danger_always = excluded.terminal_danger_always,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_kind = excluded.updated_by_kind,
           updated_at = now()
     where runtime_permission_settings.organization_id = excluded.organization_id
       and runtime_permission_settings.terminal_danger_always is distinct from excluded.terminal_danger_always
    returning runtime_id as id, true as changed
  `;
  return rows[0] ?? { id: input.runtimeId, changed: false };
}
