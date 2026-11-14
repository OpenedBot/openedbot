import type { MiddlewareHandler } from "hono";
import { HttpError } from "./http-error";
import { compareSemVer, parseSemVer, type SemVer } from "@openedbot/platform-config/native-clients";
import { CLIENT_HEADER } from "./cors";

/** The code the desktop app recognizes in order to display « mise à jour requise ». */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

const DESKTOP_CLIENT = /^desktop\/(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** The version announced by `X-OpenedBot-Client: desktop/X.Y.Z`, `null` otherwise (browser, old app, malformed header). */
export function desktopClientVersion(header: string | undefined): SemVer | null {
  const match = header ? DESKTOP_CLIENT.exec(header.trim()) : null;
  return match ? parseSemVer(match[1]!) : null;
}

/**
 * Refuses with `426` a desktop app older than `DESKTOP_MIN_VERSION`.
 *
 * Only an app that announces itself is concerned: a browser, a client that
 * does not send the header, or an unreadable header pass as before; the gate
 * never cuts off a client it cannot date. The health check stays
 * open to everyone.
 */
export function clientVersionGate(minDesktopVersion: SemVer | null): MiddlewareHandler {
  return async (context, next) => {
    if (minDesktopVersion && context.req.path !== "/api/health") {
      const version = desktopClientVersion(context.req.header(CLIENT_HEADER));
      if (version && compareSemVer(version, minDesktopVersion) < 0) {
        throw new HttpError(426, CLIENT_UPDATE_REQUIRED, "Cette version de l'app openedbot n'est plus prise en charge : mettez-la à jour.", {}, {
          minVersion: minDesktopVersion.join("."),
          version: version.join("."),
        });
      }
    }
    await next();
  };
}
