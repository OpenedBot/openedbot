import { compress } from "hono/compress";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../../routes/identity/auth";

/**
 * En dessous de ce seuil, l'en-tête `Content-Encoding` et le passage par
 * `CompressionStream` coûtent plus que les octets épargnés. C'est le défaut de
 * Hono, repris ici pour qu'il soit lisible et testable.
 *
 * Il ne s'applique QUE si la réponse porte déjà un `Content-Length` : Hono ne
 * bufferise pas un corps de taille inconnue pour le mesurer, et c'est le bon
 * choix : mesurer, ce serait attendre la fin du corps avant d'émettre. Une
 * petite réponse sans `Content-Length` traverse donc quand même le
 * compresseur ; le coût est de l'ordre de la microseconde, la seule alternative
 * était de casser le streaming.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Les types de corps que l'API a intérêt à compresser : ses réponses de contrat
 * (JSON) et les rares corps texte. Tout le reste : pièces jointes binaires,
 * images, et surtout `text/event-stream` : est laissé intact.
 *
 * Liste blanche et non liste noire : un nouveau type de corps n'est jamais
 * compressé par accident, il faut l'ajouter ici en connaissance de cause.
 */
export function isCompressibleContentType(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json") ||
    type === "text/plain" || type === "text/markdown";
}

/**
 * Les chemins dont la réponse ne doit JAMAIS traverser un compresseur.
 *
 * - `/api/events` est le flux SSE : gzip écrit par blocs, donc un événement
 *   resterait coincé dans le compresseur jusqu'au bloc suivant. Sur un flux
 *   tenu ouvert des minutes, cela veut dire des deltas qui arrivent en paquet
 *   au lieu d'arriver au fil de l'eau : exactement ce que le flux existe pour
 *   éviter. La route pose déjà `Cache-Control: no-transform` et un
 *   `Content-Type` hors liste blanche : cette exclusion par chemin est la
 *   troisième garde, celle qui ne dépend pas de ce que la route émet.
 * - `/internal/runtime-links/*` est le relais du lien connecteur vers le
 *   worker : il transporte des flux SSE gateway et des corps binaires dans
 *   les deux sens. Il n'est pas monté sous `/api/*`, donc jamais compressé
 *   aujourd'hui ; l'exclusion par chemin le garantit quel que soit le montage.
 * - `/api/auth/*` porte le jeton CSRF dans le corps JSON (`csrfToken`).
 *   Compresser une réponse qui mêle un secret et une entrée contrôlable, c'est
 *   la configuration de BREACH ; ces corps font quelques centaines d'octets,
 *   on ne perd rien à les laisser en clair.
 * - `/api/support/*` cumule les deux raisons : le flux du guichet y vit, et
 *   l'ouverture d'un fil rend le jeton du visiteur dans un corps JSON qui
 *   contient aussi l'adresse qu'il vient de taper. Le flux staff, lui, est
 *   déjà couvert par `/api/pro/staff/*`, dont
 *   la connexion rend aussi un jeton CSRF.
 */
export function isUncompressedPath(path: string): boolean {
  return path === "/api/events" || path.startsWith("/api/events/") ||
    path === "/internal/runtime-links" || path.startsWith("/internal/runtime-links/") ||
    path === "/api/auth" || path.startsWith("/api/auth/") ||
    path === "/api/pro/staff" || path.startsWith("/api/pro/staff/") ||
    path === "/api/support" || path.startsWith("/api/support/");
}

/**
 * gzip/deflate sur les réponses JSON de l'API, jamais sur le flux SSE.
 *
 * L'exclusion est faite AVANT `next()` : le compresseur n'est même pas monté
 * sur le chemin exclu, donc aucune version future de Hono ne peut décider
 * d'envelopper le flux malgré son `Content-Type`.
 */
export function responseCompression(): MiddlewareHandler<{ Variables: AppVariables }> {
  const gzip = compress({
    threshold: COMPRESSION_THRESHOLD_BYTES,
    contentTypeFilter: (type) => isCompressibleContentType(type),
  });
  return async (context, next) => {
    if (isUncompressedPath(context.req.path)) return next();
    return gzip(context, next);
  };
}
