import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * `memberLimit` comes from the plan (`subscriptionPort().read()`); without a
 * subscription there is no limit and the caller does not ask. `occupied`
 * counts live members plus pending invitations: an invitation holds its seat.
 */
export function assertMemberCapacity(memberLimit: number, occupied: number): void {
  if (!Number.isSafeInteger(memberLimit) || memberLimit < 0 || !Number.isSafeInteger(occupied) || occupied < 0) {
    throw new Error("Member capacity values are invalid.");
  }
  if (occupied >= memberLimit) {
    throw new HttpError(
      409,
      "MEMBER_QUOTA_REACHED",
      "La limite de membres de cet espace est atteinte.",
    );
  }
}

export function assertMutableMemberRole(role: "owner" | "admin" | "member"): void {
  if (role === "owner") {
    throw new HttpError(
      403,
      "OWNER_ROLE_PROTECTED",
      "Le rôle owner ne peut pas être modifié ou retiré depuis cette route.",
    );
  }
}
