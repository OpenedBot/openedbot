/**
 * Whether a runtime just enrolled should become the one that serves runs.
 *
 * Enrollment activates the new runtime only when the organization has none.
 * Re-enrolling a dead connector (the host's previous runtime, link closed)
 * used to leave the PWA on that dead row: the new one existed and served
 * nothing; that dead row is now retired (revoked) in the same transaction.
 * A connector whose link is still open is never taken over: the new runtime
 * waits as the pending replacement (`POST /api/runtime/:id/replace`).
 */
export function enrolledRuntimeActivation(
  rows: readonly { id: string; isActive: boolean; reachability: string; linkConnectedAt: Date | string | null }[],
): { active: boolean; retireId: string | null } {
  const current = rows.find((row) => row.isActive);
  if (!current) return { active: true, retireId: null };
  if (current.reachability === "connector" && current.linkConnectedAt === null) {
    return { active: true, retireId: current.id };
  }
  return { active: false, retireId: null };
}
