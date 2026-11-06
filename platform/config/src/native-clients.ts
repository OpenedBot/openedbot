/**
 * Les clients natifs (l'app de bureau) vus par l'API.
 *
 * La console embarquée dans l'app de bureau est servie depuis une origine
 * locale (`tauri://localhost` sur macOS et Linux, `http://tauri.localhost` sur
 * Windows) et parle à l'API en `Authorization: Bearer`, sans cookie. Ces
 * origines passent donc le CORS **sans** `Access-Control-Allow-Credentials` :
 * un cookie de session web ne peut jamais servir depuis l'une d'elles. Elles
 * restent distinctes de `webOrigins`, qui décident des `returnTo` de confiance.
 *
 * `DESKTOP_MIN_VERSION` : sous cette version, un client qui s'annonce
 * `X-OpenedBot-Client: desktop/X.Y.Z` reçoit `426` et l'invitation à se mettre
 * à jour, au lieu d'erreurs au hasard d'une console embarquée trop vieille.
 */
export type NativeClients = {
  origins: string[];
  minDesktopVersion: SemVer | null;
};

export type SemVer = readonly [major: number, minor: number, patch: number];

export const DEFAULT_NATIVE_APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost"] as const;

/** Une origine exacte `scheme://hôte[:port]`, sans chemin : jamais `null` ni `*`. */
const NATIVE_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export function readNativeClients(env: { NATIVE_APP_ORIGINS?: string; DESKTOP_MIN_VERSION?: string }, webOrigins: readonly string[]): NativeClients {
  const raw = env.NATIVE_APP_ORIGINS?.trim();
  const origins = raw === undefined || raw === "" ? [...DEFAULT_NATIVE_APP_ORIGINS] : raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const origin of origins) {
    if (!NATIVE_ORIGIN.test(origin)) {
      throw new Error(`NATIVE_APP_ORIGINS: "${origin}" is not an exact origin (scheme://host[:port], lowercase, no path).`);
    }
    // Une origine web listée ici perdrait ses cookies en CORS : on refuse le mélange.
    if (webOrigins.includes(origin)) {
      throw new Error(`NATIVE_APP_ORIGINS: "${origin}" is already a web origin; list it in one place only.`);
    }
  }
  const min = env.DESKTOP_MIN_VERSION?.trim();
  if (!min) return { origins: [...new Set(origins)], minDesktopVersion: null };
  const version = parseSemVer(min);
  if (!version) throw new Error(`DESKTOP_MIN_VERSION must be X.Y.Z, got "${min}".`);
  return { origins: [...new Set(origins)], minDesktopVersion: version };
}

export function parseSemVer(value: string): SemVer | null {
  const match = SEMVER.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}
