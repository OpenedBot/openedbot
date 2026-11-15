import type { ManagedExposurePort, ProPlugin } from "./contract";
import { hookContext } from "./config";
export function managedExposureOf(plugins: readonly ProPlugin[], env: Readonly<Record<string, string | undefined>> = {}): ManagedExposurePort | null {
  const plugin = plugins.find((candidate) => candidate.manifest.id === "cloud");
  const port = plugin?.managedExposure?.(hookContext(plugin, env)) ?? null;
  if (port && (typeof port.create !== "function" || typeof port.cleanup !== "function")) throw new Error("Invalid managed exposure provider");
  return port;
}
