import type { RuntimeMode } from "@openedbot/contracts-api";

/** Compatibility parser: runtime selection now belongs to each runtime. */
export type RuntimeEnvironment = "development" | "test" | "production";

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "external";
}

export function readRuntimeMode(value: string | undefined, _environment: RuntimeEnvironment): RuntimeMode {
  if (value !== undefined) console.warn("OHB_RUNTIME_MODE is retired and ignored; runtime mode is external.");
  return "external";
}
