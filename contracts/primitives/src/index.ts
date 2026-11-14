/**
 * Shared pure primitives: UUID identifiers, ISO instants and reading
 * of unknown objects. Each function keeps the exact semantics of the copies
 * it replaces; when two copies diverged, both variants
 * exist under a distinct name.
 */
export { UUID_LOOSE_BODY, UUID_LOOSE_RE, UUID_STRICT_BODY, UUID_STRICT_RE, isStrictUuid, isUuid } from "./uuid";
export { isoInstant, isoInstantLenient, isoOrNull, isoUnlessNull } from "./iso";
export { asRecord, isRecord, stringValue } from "./record";
