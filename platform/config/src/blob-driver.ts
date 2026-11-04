/**
 * Où vivent les pièces jointes : R2 quand il est vraiment configuré, sinon un
 * volume du serveur.
 *
 * La production exigeait R2 et refusait le disque. Mais le provisionnement pose
 * des valeurs neutralisées tant que R2 n'est pas ouvert (`https://r2.invalid`,
 * `alpha-r2-not-provisioned`, rôle Ansible `ohb_alpha`) : l'API démarrait, puis
 * chaque envoi de fichier finissait en 500 sur un échec DNS. Le repli par défaut
 * est donc le volume, annoncé à chaque démarrage (`fallbackReason`), jamais
 * silencieux. R2 reprend la main dès que ses quatre valeurs sont réelles.
 */

/** Les valeurs posées par le provisionnement tant que R2 n'est pas ouvert. */
export const R2_PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(["alpha-r2-not-provisioned"]);

/** Le volume monté par la composition de production (`infra/shuttle/ohb-console`). */
export const PRODUCTION_FILE_BLOB_ROOT = "/var/lib/ohb/blobs";

export type BlobDriverChoice = {
  driver: "file" | "r2";
  /** Pourquoi le disque a été pris à la place de R2 ; null quand c'est le choix voulu. */
  fallbackReason: string | null;
};

type Env = Record<string, string | undefined>;

/** Ce qui manque à R2 pour servir ; vide quand il est utilisable. */
export function r2ConfigurationProblems(env: Env): string[] {
  const problems: string[] = [];
  for (const name of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} absent`);
    else if (R2_PLACEHOLDER_VALUES.has(value)) problems.push(`${name} neutralisé`);
  }
  const endpoint = env.R2_ENDPOINT?.trim();
  if (endpoint) {
    let host = "";
    try {
      host = new URL(endpoint).hostname;
    } catch {
      problems.push("R2_ENDPOINT n'est pas une URL");
    }
    // `.invalid` (RFC 2606) ne se résout jamais : c'est la valeur neutralisée.
    if (host === "invalid" || host.endsWith(".invalid")) problems.push("R2_ENDPOINT neutralisé (.invalid)");
  }
  return problems;
}

/**
 * `BLOB_DRIVER=file` : le disque, partout. `BLOB_DRIVER=r2`, ou rien en production :
 * R2 s'il est configuré, sinon le disque avec sa raison. Rien hors production : le disque.
 */
export function resolveBlobDriver(env: Env, production: boolean): BlobDriverChoice {
  const declared = env.BLOB_DRIVER?.trim() || "";
  if (declared && declared !== "file" && declared !== "r2") {
    throw new Error("BLOB_DRIVER must be either file or r2.");
  }
  if (declared === "file") return { driver: "file", fallbackReason: null };
  if (declared === "r2" || production) {
    const problems = r2ConfigurationProblems(env);
    if (problems.length === 0) return { driver: "r2", fallbackReason: null };
    return { driver: "file", fallbackReason: `R2 non configuré : ${problems.join(", ")}` };
  }
  return { driver: "file", fallbackReason: null };
}

/** Le dossier du disque : `BLOB_FILE_ROOT`, sinon le volume de production ou `.data/blobs`. */
export function fileBlobRoot(env: Env, production: boolean): string {
  return env.BLOB_FILE_ROOT?.trim() || (production ? PRODUCTION_FILE_BLOB_ROOT : ".data/blobs");
}

/** Les accès R2 sans la diffusion CDN : de quoi relire et supprimer un objet. */
export type R2BlobCredentials = { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };

/**
 * L'AUTRE magasin, celui qui n'écrit plus : chaque objet est lu et supprimé
 * par le driver que sa ligne a persisté, pas par celui du jour. Le disque est
 * toujours connu (son dossier se dérive) ; R2 seulement si ses quatre valeurs
 * sont réelles. `null` : un objet de cet autre magasin est injoignable, et
 * toute lecture ou suppression qui le vise échoue au lieu de viser le mauvais.
 */
export type BlobOtherBackend = ({ driver: "file"; root: string } | ({ driver: "r2" } & R2BlobCredentials)) | null;

export function otherBlobBackend(env: Env, current: "file" | "r2", fileRoot: string): BlobOtherBackend {
  if (current === "r2") return { driver: "file", root: fileRoot };
  if (r2ConfigurationProblems(env).length > 0) return null;
  return {
    driver: "r2",
    bucket: env.R2_BUCKET!.trim(),
    endpoint: env.R2_ENDPOINT!.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
  };
}
