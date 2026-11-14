import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readApiInternalUrl } from "./api-address";

/**
 * What a client's `vite.config.ts` needs from the environment.
 *
 * The dev servers used to hardcode `http://127.0.0.1:8790` and their own port.
 * Both are already declared: `API_PORT` for the API, `WEB_APP_URL` for the
 * web client, so a literal here could only
 * disagree with them: move the API to another port and the proxy kept dialling
 * the old one.
 *
 * A Vite config runs before the app, in Node, with no bundler alias: it reads
 * the private files itself rather than relying on the Makefile having sourced
 * them, so `bun run --cwd apps/console dev` behaves like `make dev-console`.
 */

const ENV_FILE_NAMES = [".env", ".env.local"] as const;

function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

function readEnvDir(dir: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of ENV_FILE_NAMES) {
    const path = join(dir, name);
    if (existsSync(path)) Object.assign(values, parseEnvText(readFileSync(path, "utf8")));
  }
  return values;
}

/**
 * The repository root's env files, then the workspace's own, then the real
 * process environment, which wins, so `make dev` and CI can override.
 *
 * A production build reads NOTHING from disk: those files are private, hold a
 * developer's own values, and a deployable artefact must depend only on what
 * the deployment passed. Otherwise a workstation's `API_PORT=9000` ends up
 * baked into the build.
 */
export function loadClientEnv(
  repoRoot: string,
  workspaceDir: string,
  mode: string = "development",
): Record<string, string | undefined> {
  if (mode === "production") return { ...process.env };
  return { ...readEnvDir(repoRoot), ...readEnvDir(workspaceDir), ...process.env };
}

/**
 * Origin the dev server and `vite preview` proxy `/api` to.
 *
 * Development only. It falls back to loopback, which is meaningless anywhere
 * but the machine that also runs the API, never use it for a rule that
 * survives into a build (see `apiRuntimeOrigin`).
 */
export function apiProxyTarget(env: Record<string, string | undefined>): string {
  return readApiInternalUrl(env.API_INTERNAL_URL, env.API_PORT);
}

/**
 * Origin for a rule that is still evaluated at runtime, in the deployed
 * artefact: Nitro's `routeRules` in `apps/admin`.
 *
 * In production the value has to come from the deployment and cannot be
 * guessed: loopback only ever meant "the API is on this very host", which is
 * the one thing a deployed backoffice cannot assume. Baking it produced a
 * build that looked fine and proxied to nothing, so this throws instead.
 */
/**
 * Whether a host can only ever mean "this very machine".
 *
 * `URL` keeps the brackets of an IPv6 host (`[::1]`), and the whole 127/8
 * block is loopback, not just 127.0.0.1: comparing against a couple of
 * literal strings silently let both through.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

export function apiRuntimeOrigin(env: Record<string, string | undefined>, mode: string): string {
  if (mode !== "production") return apiProxyTarget(env);
  const origin = env.API_INTERNAL_URL?.trim();
  if (!origin) {
    throw new Error(
      "API_INTERNAL_URL is required for a production build: it is baked into Nitro's routeRules, " +
        "so the deployment must say where the API is. There is no sane default.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`API_INTERNAL_URL must be an absolute URL, got ${origin}.`);
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `API_INTERNAL_URL=${origin} is a loopback origin; a deployed backoffice would proxy to itself. ` +
        "Give the API's reachable internal origin.",
    );
  }
  return origin.replace(/\/+$/u, "");
}

/**
 * The port a client serves on, taken from its own canonical origin so the URL
 * the rest of the system builds and the port Vite binds cannot disagree.
 */
export function clientPort(originUrl: string | undefined, fallback: number): number {
  const raw = originUrl?.trim();
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Expected an absolute URL, got ${raw}.`);
  }
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}
