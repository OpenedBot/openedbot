import type { ManagedExposurePort } from "@openedbot/platform-plugins";

let installed: ManagedExposurePort | null = null;

/** Missing plug-in: no managed creation; existing cleanup remains recoverable. */
export function installManagedExposure(port: ManagedExposurePort | null): void {
  installed = port;
}

export function managedExposure(): ManagedExposurePort | null {
  return installed;
}
