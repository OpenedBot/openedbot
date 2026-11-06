/** The worker's retention passes over sessions and email login codes (ADR 0001 S4). */
export { purgeDeadSessions, purgeSpentEmailLoginCodes } from "../sql/auth-retention";
