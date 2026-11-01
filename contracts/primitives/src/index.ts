/**
 * Primitives pures partagées : identifiants UUID, instants ISO et lecture
 * d'objets inconnus. Chaque fonction garde la sémantique exacte des copies
 * qu'elle remplace ; quand deux copies divergeaient, les deux variantes
 * existent sous un nom distinct.
 */
export { UUID_LOOSE_BODY, UUID_LOOSE_RE, UUID_STRICT_BODY, UUID_STRICT_RE, isStrictUuid, isUuid } from "./uuid";
export { isoInstant, isoInstantLenient, isoOrNull, isoUnlessNull } from "./iso";
export { asRecord, isRecord, stringValue } from "./record";
