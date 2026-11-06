/**
 * The Hermes profile import lock and the name reservations an import holds,
 * for the imports (portability) and the API (ADR 0001 S4). They throw
 * `ProfileImportError`; `./profile-import-guard` turns that into an HTTP error
 * for the roster's own use cases.
 */
export { assertProfileNamesAvailable, lockProfileImports } from "../sql/profile-reservations";
