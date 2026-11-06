import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/**
 * La Content-Security-Policy de la console, posée DANS le build : une balise
 * `<meta http-equiv>` en tête de `index.html`. Elle voyage donc avec le
 * fichier, identique en prod (`infra/shuttle/web-server.js`), en préprod (le
 * Caddy de `infra/console.openedbot.app`) et dans la fenêtre de l'app
 * desktop, sans liste d'empreintes à recopier dans trois serveurs.
 *
 * Pourquoi elle compte : dans l'app desktop, tout script de la page atteint
 * `window.__OPENEDBOT_NATIVE__.readAccessToken()`. Une injection de script vaudrait
 * vol de session ; `script-src` n'admet que les fichiers du site, les scripts
 * inline de démarrage par leur empreinte et les scripts externes déclarés
 * dans `index.html` (la mesure d'audience).
 *
 * Ce qu'une balise meta ne porte pas (`frame-ancestors`, `sandbox`,
 * `report-uri`) part en en-tête HTTP, du serveur qui sert la page.
 *
 * Au build seulement : le serveur de dev de Vite injecte ses propres scripts
 * inline (préambule de React Refresh) qu'aucune empreinte ne couvrirait.
 */

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const EXTERNAL_SCRIPT = /<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"/gi;

function sha256(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function origins(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") out.add(url.origin);
    } catch {
      // Pas une URL absolue : rien à autoriser.
    }
  }
  return [...out].sort();
}

/**
 * L'origine de l'API dans la politique de l'app de bureau Tauri
 * (`VITE_OPENEDBOT_SHELL=tauri`) : un réglage d'exécution là-bas, pas de build.
 * La coque remplace ce marqueur en servant `index.html` (`src-tauri/src/csp.rs`,
 * même nom) ; les deux bougent ensemble.
 */
export const DESKTOP_API_ORIGIN_PLACEHOLDER = "__OPENEDBOT_DESKTOP_API_ORIGIN__";

/**
 * L'IPC de Tauri : `ipc://localhost` sur macOS et Linux, `http://ipc.localhost`
 * sur Windows. Sans eux, Tauri retombe sur `postMessage`, plus lent.
 */
const TAURI_IPC = ["ipc:", "http://ipc.localhost"];

/** Le script de mesure d'audience : sorti du build desktop (ADR 0001, 4.4). */
const ANALYTICS_SCRIPT = /\s*<!-- Mesure d'audience[^>]*-->\s*<script\b[^>]*\bsrc="https:\/\/umami\.[^"]+"[^>]*><\/script>/;

export function withoutAnalytics(html: string): string {
  const stripped = html.replace(ANALYTICS_SCRIPT, "");
  if (new RegExp(EXTERNAL_SCRIPT.source, "i").test(stripped)) {
    throw new Error("index.html du build desktop : un script externe reste après le retrait de la mesure d'audience");
  }
  return stripped;
}

/**
 * La politique pour ce HTML. `apiOrigin` : `VITE_API_ORIGIN` quand la console
 * appelle une API sur un autre nom ; vide, l'API est sur le nom de la page.
 * `desktop` : la console embarquée dans l'app Tauri, servie depuis l'origine
 * locale, qui parle à l'API choisie à l'exécution et à la coque par l'IPC.
 */
export function consolePolicy(html: string, apiOrigin = "", options: { desktop?: boolean } = {}): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((match) => sha256(match[1] ?? "")).sort();
  const scriptOrigins = origins([...html.matchAll(EXTERNAL_SCRIPT)].map((match) => match[1] ?? ""));
  const api = options.desktop ? [DESKTOP_API_ORIGIN_PLACEHOLDER] : origins(apiOrigin ? [apiOrigin] : []);
  const ipc = options.desktop ? TAURI_IPC : [];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...hashes, ...scriptOrigins]],
    // Les attributs `style` du squelette de démarrage et la balise <style>
    // du même bloc ; les bibliothèques d'interface en posent aussi.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Les pièces jointes et les visages de bots arrivent en blob: (lus avec
    // l'en-tête d'authentification, jamais par une URL à jeton).
    ["img-src", ["'self'", "data:", "blob:", ...api]],
    ["font-src", ["'self'", "data:"]],
    // La mesure d'audience envoie ses mesures au nom qui sert son script.
    ["connect-src", ["'self'", ...ipc, ...api, ...scriptOrigins]],
    ["media-src", ["'self'", "data:", "blob:", ...api]],
    // L'aperçu d'un document HTML de bot est un srcdoc sandboxé : il hérite
    // de cette politique, ses scripts n'y tournent donc pas (voulu, voir
    // `attachment-canvas.tsx`). Aucune autre origine ne s'encadre ici.
    ["frame-src", ["'self'"]],
    ["worker-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** Insère la balise juste après `<head>`, avant tout script qu'elle doit couvrir. */
export function injectPolicy(html: string, policy: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new Error("index.html sans <head> : la CSP ne peut pas être posée");
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

export function contentSecurityPolicy(): Plugin {
  let apiOrigin = "";
  let desktop = false;
  return {
    name: "openedbot-console-csp",
    apply: "build",
    configResolved(config) {
      apiOrigin = String(config.env.VITE_API_ORIGIN ?? "").trim();
      desktop = config.env.VITE_OPENEDBOT_SHELL === "tauri";
      if (desktop && apiOrigin) throw new Error("VITE_API_ORIGIN n'a pas de sens dans le build desktop : l'origine de l'API y est choisie à l'exécution");
    },
    transformIndexHtml: {
      // Après les autres plugins : les empreintes portent sur le HTML final.
      order: "post",
      handler: (html) => {
        const page = desktop ? withoutAnalytics(html) : html;
        return injectPolicy(page, consolePolicy(page, apiOrigin, { desktop }));
      },
    },
  };
}
