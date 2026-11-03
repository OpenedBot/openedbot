import { HttpError } from "@openedbot/contracts-errors/http-error";

export function assertMemberCapacity(memberLimit: number, occupied: number): void {
  if (!Number.isSafeInteger(memberLimit) || memberLimit < 0 || !Number.isSafeInteger(occupied) || occupied < 0) {
    throw new Error("Member capacity values are invalid.");
  }
  if (occupied >= memberLimit) {
    throw new HttpError(
      409,
      "MEMBER_QUOTA_REACHED",
      "La limite de deux membres est atteinte. Une offre supérieure est nécessaire.",
    );
  }
}

export function assertMutableMemberRole(role: "owner" | "admin" | "member" | "agency"): void {
  if (role === "owner") {
    throw new HttpError(
      403,
      "OWNER_ROLE_PROTECTED",
      "Le rôle owner ne peut pas être modifié ou retiré depuis cette route.",
    );
  }
}
