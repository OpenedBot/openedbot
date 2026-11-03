import type { Db } from "@openedbot/platform-db";
import { isoInstant } from "@openedbot/contracts-primitives";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { pauseMemberRoutines } from "@openedbot/execution/sql/routines";
import { dropMemberPushSubscriptions } from "@openedbot/notifications/sql/push-subscriptions";
import { assertMutableMemberRole } from "../domain/member-policy";
import {
  listActiveMembers,
  lockOrganizationForMembership,
  readActiveMembershipRole,
  recordMemberRevoked,
  recordRoleChanged,
  revokeMembership,
  setMembershipRole,
  type MemberRow,
} from "../sql/members";

export type MemberView = Omit<MemberRow, "createdAt"> & { createdAt: string };

export async function listMembers(db: Db, organizationId: string): Promise<MemberView[]> {
  const members = await withTenant(db, organizationId, (tx) => listActiveMembers(tx, organizationId));
  return members.map((member) => ({ ...member, createdAt: isoInstant(member.createdAt) }));
}

/** Change le rôle d'un membre vivant ; le propriétaire ne se modifie pas (`assertMutableMemberRole`). */
export async function changeMemberRole(db: Db, input: {
  organizationId: string;
  actorUserId: string;
  userId: string;
  role: "admin" | "member";
}): Promise<void> {
  await withTenant(db, input.organizationId, async (tx) => {
    await lockOrganizationForMembership(tx, input.organizationId);
    const current = await readActiveMembershipRole(tx, input.organizationId, input.userId, { lock: true });
    if (!current) throw new HttpError(404, "MEMBER_NOT_FOUND", "Ce membre est introuvable.");
    assertMutableMemberRole(current);
    await recordRoleChanged(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      subjectUserId: input.userId,
      role: input.role,
    });
    await setMembershipRole(tx, input.organizationId, input.userId, input.role);
  });
}

/** Révoque un membre : son accès, ses notifications et ses routines s'arrêtent dans la même transaction. */
export async function removeMember(db: Db, input: {
  organizationId: string;
  actorUserId: string;
  userId: string;
}): Promise<void> {
  await withTenant(db, input.organizationId, async (tx) => {
    await lockOrganizationForMembership(tx, input.organizationId);
    const current = await readActiveMembershipRole(tx, input.organizationId, input.userId, { lock: true });
    if (!current) throw new HttpError(404, "MEMBER_NOT_FOUND", "Ce membre est introuvable.");
    assertMutableMemberRole(current);
    await revokeMembership(tx, input.organizationId, input.userId);
    await dropMemberPushSubscriptions(tx, input.organizationId, input.userId);
    // APNs devices of the member go with the revocation itself: trigger
    // `memberships_drop_apns_devices` (0108).
    await pauseMemberRoutines(tx, input.organizationId, input.userId);
    await recordMemberRevoked(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      subjectUserId: input.userId,
      role: current,
    });
  });
}
