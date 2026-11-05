/**
 * Le site public (vitrine, liste d'attente) vit hors de la console. Son
 * adresse est un réglage de build, `VITE_PUBLIC_SITE_URL` (ou
 * `window.__OPENEDBOT_PUBLIC_SITE_URL__` posé par l'hôte), jamais déduite de l'hôte
 * qui sert la console : la même build se comporte pareil sur l'hôte de la
 * console et sur le domaine nu pendant la transition. Vide (le défaut, une
 * instance solo) : aucun lien sortant, la marque ramène à l'application.
 */
declare global {
  interface Window { __OPENEDBOT_PUBLIC_SITE_URL__?: string }
}

/** Adresse absolue `http(s)` du site public, sans `/` final ; `null` sinon. */
export function publicSiteUrl(raw: string | undefined = readSetting()): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readSetting(): string | undefined {
  return globalThis.window?.__OPENEDBOT_PUBLIC_SITE_URL__ ?? import.meta.env?.VITE_PUBLIC_SITE_URL;
}
