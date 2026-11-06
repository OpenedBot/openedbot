import type { MiddlewareHandler } from "hono";
import { HttpError } from "./http-error";
import { compareSemVer, parseSemVer, type SemVer } from "@openedbot/platform-config/native-clients";
import { CLIENT_HEADER } from "./cors";

/** Le code que l'app de bureau reconnaît pour afficher « mise à jour requise ». */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

const DESKTOP_CLIENT = /^desktop\/(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** La version annoncée par `X-OpenedBot-Client: desktop/X.Y.Z`, `null` sinon (navigateur, ancienne app, en-tête mal formé). */
export function desktopClientVersion(header: string | undefined): SemVer | null {
  const match = header ? DESKTOP_CLIENT.exec(header.trim()) : null;
  return match ? parseSemVer(match[1]!) : null;
}

/**
 * Refuse en `426` une app de bureau plus vieille que `DESKTOP_MIN_VERSION`.
 *
 * Seule une app qui s'annonce est concernée : un navigateur, une ancienne app
 * Electron (qui n'envoie pas l'en-tête) ou un en-tête illisible passent comme
 * avant, la garde ne coupe jamais un client qu'elle ne sait pas dater. Le
 * bilan de santé reste ouvert à tous.
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
