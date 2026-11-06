import { nativeBridge } from "./native-bridge";

/**
 * Ce que la console demande à la plateforme qui la porte : un navigateur, ou
 * l'app de bureau. Le reste de la console passe par ici (et par les
 * réexportations de `index.ts`), jamais par `native-bridge` ni par
 * `location.origin` directement : `tests/scripts/console-platform-contract.ts`
 * le vérifie.
 *
 * Pourquoi : une console embarquée dans l'app de bureau est servie depuis une
 * origine locale (`tauri://localhost`). Un lien d'invitation, une URL de
 * webhook ou une page ouverte dans le navigateur doivent pourtant pointer sur
 * la console web publique, jamais sur cette origine locale.
 */

declare global {
  interface Window {
    /** Posé par l'app de bureau quand la console n'est pas servie par son origine publique. */
    __OPENEDBOT_PUBLIC_CONSOLE_URL__?: string;
  }
}

/** L'en-tête par lequel l'app de bureau s'annonce à l'API (`client-version.ts` côté API). */
export const CLIENT_HEADER = "X-OpenedBot-Client";

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * Une origine web publique : http(s), et pas l'hôte local sous lequel Tauri
 * sert la console sur Windows (`http://tauri.localhost`), qui passerait sinon
 * pour une origine web dans le repli sur l'origine de la page.
 */
function isWebOrigin(origin: string): boolean {
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return false;
  const host = new URL(origin).hostname;
  return host !== "tauri.localhost" && !host.endsWith(".tauri.localhost");
}

/**
 * L'origine publique de la console web (`https://openedbot.app`), sans barre
 * finale. Dans un navigateur, c'est l'origine de la page. Dans l'app de
 * bureau : la valeur posée par l'app, sinon `VITE_PUBLIC_CONSOLE_URL`, sinon
 * l'origine de la page tant qu'elle est web (l'app Electron charge la console
 * distante). Une console locale sans aucune des deux est une app mal
 * construite : l'erreur le dit au lieu de fabriquer un lien `tauri://`.
 */
export function publicConsoleOrigin(): string {
  const pageOrigin = globalThis.window?.location.origin ?? "";
  if (!nativeBridge()) return pageOrigin;
  const configured = globalThis.window?.__OPENEDBOT_PUBLIC_CONSOLE_URL__ ?? import.meta.env.VITE_PUBLIC_CONSOLE_URL ?? "";
  const trimmed = String(configured).trim().replace(/\/+$/, "");
  if (trimmed) {
    const origin = new URL(trimmed).origin;
    if (!isWebOrigin(origin)) throw new Error(`The public console URL must be http(s), got ${JSON.stringify(trimmed)}.`);
    return origin;
  }
  if (isWebOrigin(pageOrigin)) return pageOrigin;
  throw new Error("The desktop app serves the console locally but sets no public console URL (__OPENEDBOT_PUBLIC_CONSOLE_URL__ or VITE_PUBLIC_CONSOLE_URL).");
}

/** Une page de la console web publique : lien d'invitation, page ouverte dans le navigateur. */
export function publicConsoleUrl(path: string): string {
  return new URL(path, `${publicConsoleOrigin()}/`).toString();
}

/**
 * Lit un chemin de l'app (`/o/acme/bot/…`, avec sa requête et son ancre) sans
 * dépendre de l'origine de la page : seule la partie chemin compte.
 */
export function appUrl(href: string): URL {
  return new URL(href, "https://console.invalid/");
}

/** `desktop/X.Y.Z` dans l'app de bureau, `null` dans un navigateur ou si la version est illisible. */
export function desktopClientId(): string | null {
  const version = nativeBridge()?.shell?.version?.trim();
  return version && SEMVER.test(version) ? `desktop/${version}` : null;
}

/** Les en-têtes qui annoncent l'app de bureau à l'API (garde de version `426`) ; vide dans un navigateur. */
export function clientHeaders(): Record<string, string> {
  const client = desktopClientId();
  return client ? { [CLIENT_HEADER]: client } : {};
}

/**
 * Une requête de l'app de bureau : en-tête client, et jamais de cookie.
 * L'identité y est le bearer du pont, et l'API laisse passer les origines de
 * l'app sans `Access-Control-Allow-Credentials` : une requête `include` y
 * serait rejetée par la WebView. Dans un navigateur, la requête est rendue
 * telle quelle.
 */
export function nativeRequestInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!nativeBridge()) return init;
  return { ...withClientHeaders(init), credentials: "omit" };
}

/** Ajoute `clientHeaders()` à une requête, sans écraser ce que l'appelant a posé. */
export function withClientHeaders(init: RequestInit | undefined): RequestInit | undefined {
  const extra = clientHeaders();
  if (Object.keys(extra).length === 0) return init;
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(extra)) if (!headers.has(name)) headers.set(name, value);
  return { ...init, headers };
}

/**
 * Ouvre une page de la console hors de la fenêtre compacte : navigateur
 * système dans la coque, nouvel onglet sinon. La fenêtre compacte ne montre
 * que le fil (DEV-139) : réglages, flotte et accueil s'ouvrent ailleurs. Dans
 * la coque, l'adresse est celle de la console web publique, jamais l'origine
 * locale de la console embarquée.
 */
export function openInBrowser(path: string): void {
  const bridge = nativeBridge();
  if (bridge) void bridge.openExternal(publicConsoleUrl(path));
  else window.open(new URL(path, window.location.origin).toString(), "_blank", "noopener");
}
