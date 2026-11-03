/**
 * Les lignes `MEDIA:` d'une réponse, côté texte seulement (sans Hermes) :
 * partagé par le worker (`output-media.ts`) et par le fil de la console.
 *
 * Le fil lit le texte d'un tour dans ses fragments `agent.message`, diffusés
 * AVANT que le worker ne nettoie la réponse finale : sans ce filtre, la ligne
 * brute `MEDIA:/workspace/x.png` restait affichée au-dessus de l'image jointe.
 */

/**
 * Une ligne `MEDIA:` restée brute : un chemin absolu (Unix, `~/`, Windows).
 * Une mention en prose (« le préfixe MEDIA: … ») n'a pas de chemin et reste.
 */
export const MEDIA_TAG = /(^|[ \t])MEDIA:\s*[`"']?((?:\/|~\/|[A-Za-z]:[\\/])[^\s`"']+)[`"']?/gm;

export function mediaPath(raw: string): string {
  return raw.replace(/[),.;:!?]+$/, "");
}

export function mediaBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

/**
 * Le texte tel que le fil le montre : un fichier déjà joint au message
 * (`attached`, par nom) sort du texte, un autre ne garde que son nom, en code,
 * comme le message enregistré. `attached` vaut `null` tant que le run n'a pas
 * de message : une balise en toute fin de texte est alors encore en cours de
 * diffusion (son chemin peut être tronqué) et reste cachée.
 */
export function withoutMediaLines(text: string, attached: ReadonlySet<string> | null): string {
  if (!text.includes("MEDIA:")) return text;
  const replaced = text.replace(MEDIA_TAG, (match, lead: string, raw: string, offset: number) => {
    const name = mediaBasename(mediaPath(raw));
    if (attached ? attached.has(name) : offset + match.length >= text.length) return lead;
    return `${lead}\`${name}\``;
  });
  return replaced.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
