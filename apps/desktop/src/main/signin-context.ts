import { net } from "electron";
import type { DeployEnvironment, LegalSlug, SigninContext } from "../shared/bridge";
import { DEV_CONSOLE_URL, isProductionApi, type DesktopConfig } from "./config";
import { isElectronViteDev } from "./dev-reload";
import { log } from "./log";
import { environmentOf } from "./target";

const REQUEST_TIMEOUT_MS = 8_000;
const LEGAL_SLUGS: readonly LegalSlug[] = ["mentions", "privacy", "terms"];

export function isLegalSlug(value: unknown): value is LegalSlug {
  return typeof value === "string" && (LEGAL_SLUGS as readonly string[]).includes(value);
}

async function getJson(config: DesktopConfig, path: string): Promise<unknown> {
  return getJsonAt(config.apiOrigin, path);
}

async function getJsonAt(origin: string, path: string): Promise<unknown> {
  // net.fetch for the same reason as the auth calls: the OS proxy applies.
  const response = await net.fetch(`${origin}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The seeded accounts a development API publishes in /api/auth/providers; anything else carries none. */
function seededAccounts(data: Record<string, unknown>): Array<{ email: string; password: string; role: "owner" | "agency" }> {
  const seeded = Array.isArray(data.devSignIns)
    ? (data.devSignIns as unknown[])
    : data.devSignIn
      ? [{ ...record(data.devSignIn), role: "owner" }]
      : [];
  return seeded
    .map(record)
    .filter((entry) => typeof entry.email === "string" && typeof entry.password === "string")
    .map((entry) => ({
      email: entry.email as string,
      password: entry.password as string,
      role: entry.role === "agency" ? ("agency" as const) : ("owner" as const),
    }));
}

/**
 * The same two reads as the console's /login (`api.authProviders`,
 * `api.legalCatalog`), so both doors offer the same choices. A failure is
 * not fatal: unknown providers keep every button usable and the page says
 * the API is not answering; an unreadable catalog links nothing.
 */
export async function readSigninContext(config: DesktopConfig): Promise<SigninContext> {
  const [providers, legal, health] = await Promise.all([
    getJson(config, "/api/auth/providers").catch((error: unknown) => {
      log.warn(`auth providers unreadable (${error instanceof Error ? error.message : "error"})`);
      return null;
    }),
    getJson(config, "/api/legal").catch(() => null),
    getJson(config, "/api/health").catch(() => null),
  ]);
  // The API's own word wins (../.. OPENEDBOT_DEPLOY_ENV): a LAN host may well be a
  // preprod. Without it, the origin decides (target.ts).
  const said = record(health).environment;
  const environment: DeployEnvironment =
    said === "dev" || said === "preprod" || said === "prod" ? said : environmentOf(config.apiOrigin);

  const documents = Array.isArray(record(legal).documents) ? (record(legal).documents as unknown[]) : [];
  const legalSlugs = documents
    .map(record)
    .filter((entry) => entry.available === true && isLegalSlug(entry.slug))
    .map((entry) => entry.slug as LegalSlug);

  if (providers === null) return { providers: null, legal: legalSlugs, environment };
  const data = record(providers);
  const google = record(data.google);
  const reason = google.reason === "origin_unsupported" ? "origin_unsupported" : "not_configured";
  let devAccounts = seededAccounts(data);
  // A preprod API (one that says `preprod` in /api/health) may run the
  // production build on a COPY of the development data: the seeded accounts exist there,
  // but a production API never publishes credentials (assertProductionConfig).
  // A dev run aimed at preprod takes them from the development API instead
  // (OPENEDBOT_DEV_ACCOUNTS_API, default the dev PC's console), so the page offers
  // the same autofill; signing in still goes to preprod. Never in a packaged
  // build, and never against production.
  if (devAccounts.length === 0 && environment === "preprod" && isElectronViteDev) {
    const source = process.env.OPENEDBOT_DEV_ACCOUNTS_API?.trim().replace(/\/+$/, "") || DEV_CONSOLE_URL;
    devAccounts = await getJsonAt(source, "/api/auth/providers")
      .then((published) => seededAccounts(record(published)))
      .catch((error: unknown) => {
        log.warn(`dev accounts unreadable from the development API (${error instanceof Error ? error.message : "error"})`);
        return [];
      });
  }
  const googleEnabled = google.enabled !== false;
  // Production signs in with Google only (operator's call, 2026-10-14): the
  // e-mail and password form stays for the lab and the dev PC. If production
  // ever turns Google off, the form comes back rather than lock everyone out.
  const passwordEnabled = record(data.password).enabled !== false && !(isProductionApi(config) && googleEnabled);
  return {
    providers: {
      google: googleEnabled ? { enabled: true } : { enabled: false, reason },
      password: { enabled: passwordEnabled },
      devAccounts,
    },
    legal: legalSlugs,
    environment,
  };
}
