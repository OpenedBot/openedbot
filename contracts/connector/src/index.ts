/**
 * The connector contract for the rest of the repository. The source of truth is in
 * `protocol/connector` (`@openedbot/protocol-connector`), publishable alone;
 * this package re-exports it without a copy, under the name the repository and the plugins
 * already import.
 */
export * from "@openedbot/protocol-connector";
