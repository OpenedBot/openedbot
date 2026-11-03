/**
 * Les fichiers qu'un bot livre DANS sa réponse finale.
 *
 * Un bot désigne un fichier fabriqué par une ligne `MEDIA:<chemin>` (la
 * convention de Hermes). Les routes de chat de Hermes remplacent la ligne par
 * une image intégrée, `![image](data:image/png;base64,…)`, quand l'hôte peut
 * lire le chemin (`_resolve_media_to_data_urls`, gateway/platforms/api_server.py).
 * `/v1/runs`, celle qu'openedbot pilote, la rend telle quelle (mesuré sur la
 * VM 240, 2026-11-03) : le worker lit alors le fichier par la route hôte
 * `workspace/files` quand il est à la racine de `/workspace`
 * (`workspaceMediaNames`, puis `extractOutputMedia(output, fetched)`).
 *
 * Le fil ne peut afficher ni l'image intégrée ni la ligne brute : son
 * Markdown retire les adresses `data:`, et une ligne `MEDIA:` est un chemin du
 * serveur. Le worker sort donc les images du texte pour en faire des pièces
 * jointes, et remplace une ligne `MEDIA:` restée sans fichier par le seul nom
 * du fichier, en code : le texte reste lisible dans toutes les langues, sans
 * prétendre montrer ce qui n'est pas là.
 */

import { ATTACHMENT_LIMITS } from "@openedbot/conversation/domain/attachments";
import { WORKSPACE_FILE_NAME_PATTERN, type HermesWorkspaceFile } from "@openedbot/hermes";
import { MEDIA_TAG, mediaBasename as basename, mediaPath } from "./output-media-text";
import type { RuntimeArtifact } from "./runtime-artifacts";

/** Le point de montage, dans le bac à sable, que la route hôte sert. */
const WORKSPACE_PREFIX = "/workspace/";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/** Une image intégrée en Markdown : `![texte](data:image/png;base64,…)`. */
const INLINE_IMAGE = /!\[([^\]\n]*)\]\(\s*data:(image\/[a-z+.-]+);base64,([^)]*?)\s*\)/g;

export type OutputMedia = {
  /** La réponse sans les images intégrées ni les lignes `MEDIA:` brutes. */
  text: string;
  /** Les fichiers à joindre au message, dans l'ordre de la réponse. */
  images: RuntimeArtifact[];
  /** Les fichiers désignés que l'hôte n'a pas pu lire (noms seulement). */
  unresolved: string[];
};

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** `superagent.png`, ou `image-2.png` quand le texte alternatif ne nomme rien. */
function imageName(alt: string, extension: string, index: number): string {
  const stem = alt.trim().replace(/[\\/:*?"<>|\n]+/g, " ").trim().slice(0, 80);
  if (stem && stem.toLowerCase() !== "image") return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
  return index === 0 ? `image${extension}` : `image-${index + 1}${extension}`;
}

/** `/workspace/chart.png` → `chart.png` ; tout autre chemin → `null`. */
function workspaceName(path: string): string | null {
  if (!path.startsWith(WORKSPACE_PREFIX)) return null;
  const name = path.slice(WORKSPACE_PREFIX.length);
  return WORKSPACE_FILE_NAME_PATTERN.test(name) ? name : null;
}

/**
 * Les fichiers que la réponse désigne à la racine de `/workspace`, sans
 * doublon, dans l'ordre : ceux que la route hôte peut servir. Plafonné au
 * nombre de pièces jointes d'un message.
 */
export function workspaceMediaNames(output: unknown): string[] {
  if (typeof output !== "string" || !output.includes("MEDIA:")) return [];
  const names = new Set<string>();
  for (const match of output.matchAll(MEDIA_TAG)) {
    const name = workspaceName(mediaPath(match[2]!));
    if (name) names.add(name);
    if (names.size >= ATTACHMENT_LIMITS.maxCount) break;
  }
  return [...names];
}

/**
 * `fetched` : les fichiers que le worker a lus sur l'hôte, par nom
 * (`workspaceMediaNames`). Une ligne `MEDIA:` qui en désigne un devient une
 * pièce jointe et sort du texte ; les autres gardent le seul nom.
 */
export function extractOutputMedia(output: unknown, fetched: ReadonlyMap<string, HermesWorkspaceFile> = new Map()): OutputMedia {
  if (typeof output !== "string" || (!output.includes("data:image/") && !output.includes("MEDIA:"))) {
    return { text: typeof output === "string" ? output : "", images: [], unresolved: [] };
  }
  const images: RuntimeArtifact[] = [];
  const unresolved: string[] = [];
  let total = 0;
  const fits = (bytes: number) => bytes > 0
    && bytes <= ATTACHMENT_LIMITS.maxBytesEach
    && images.length < ATTACHMENT_LIMITS.maxCount
    && total + bytes <= ATTACHMENT_LIMITS.maxBytesTotal;
  let text = output.replace(INLINE_IMAGE, (match, alt: string, contentType: string, payload: string) => {
    const extension = IMAGE_TYPES[contentType.toLowerCase()];
    const data = extension ? decodeBase64(payload) : null;
    const name = imageName(alt, extension ?? ".img", images.length);
    // Hors type, illisible ou trop lourde : le nom reste, jamais les octets en texte.
    if (!extension || !data || !fits(data.byteLength)) {
      unresolved.push(name);
      return `\`${name}\``;
    }
    total += data.byteLength;
    images.push({ path: name, name, contentType: contentType.toLowerCase(), kind: "image", data });
    return "";
  });
  const attached = new Set<string>();
  text = text.replace(MEDIA_TAG, (_match, lead: string, raw: string) => {
    const path = mediaPath(raw);
    const name = basename(path);
    const key = workspaceName(path);
    const file = key ? fetched.get(key) : undefined;
    // Le même fichier nommé deux fois n'est joint qu'une fois.
    if (key && attached.has(key)) return lead;
    if (key && file && fits(file.bytes.byteLength)) {
      attached.add(key);
      total += file.bytes.byteLength;
      const kind = file.contentType === "application/pdf" ? "document" : "image";
      images.push({ path: name, name, contentType: file.contentType, kind, data: file.bytes });
      return lead;
    }
    unresolved.push(name);
    return `${lead}\`${name}\``;
  });
  // Une image retirée laisse sa ligne vide : pas de trou dans la réponse.
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, images, unresolved };
}
