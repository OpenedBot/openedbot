import type { RuntimeMode } from "@openedbot/contracts-api";

/**
 * Runtime selection belongs to each runtime: the apps always run in the
 * `external` mode.
 */
/** The deployment environments the configuration distinguishes. */
export type RuntimeEnvironment = "development" | "test" | "production";

export const RUNTIME_MODE: RuntimeMode = "external";

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "external";
}
