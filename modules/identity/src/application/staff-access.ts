/**
 * The writes of `users` and `sessions` the staff backoffice (plug-in) triggers,
 * with its own transaction (ADR 0001 S4): the SQL stays with identity.
 */
export {
  insertImpersonatedSession,
  insertProvisionedUser,
  reopenUserAccess,
  setUserAccessTier,
} from "../sql/staff-access";
