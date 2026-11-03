/**
 * OHB-75 : comment un gateway direct a été publié.
 *
 * - `managed_cloudflare` : tunnel, DNS et Access créés sur le compte Cloudflare
 *   d'openedbot, hostname sous le suffixe géré (`<slug>.rt.openedbot.app`).
 * - `tailscale_funnel` : attribut `funnel` et clé d'appairage posés sur le
 *   tailnet du client ; le hostname est le nom MagicDNS de la machine.
 *
 * Les deux voies qui exigeaient un domaine Cloudflare chez le client (parcours
 * assisté sur son compte, et guide manuel) ont été retirées : elles
 * demandaient un prérequis que le lien openedbot n'a pas.
 */
export type RuntimeExposureKind = "managed_cloudflare" | "tailscale_funnel";

/**
 * Ce que la base peut porter, publications historiques comprises.
 *
 * `customer_cloudflare` n'est plus produit par l'API mais reste écrit sur les
 * lignes créées avant son retrait : elles restent lisibles, révocables, et
 * affichées sous un libellé « retiré ».
 */
export type RuntimeExposureStoredKind = RuntimeExposureKind | "customer_cloudflare";

/**
 * `awaiting_install` : la commande à coller n'a pas encore été jouée sur l'hôte.
 * `reachable` : le tunnel est Healthy chez Cloudflare, ou le hostname Funnel répond.
 * `declared` : la ligne `runtimes` existe et porte les accès.
 */
export type RuntimeExposureStatus = "awaiting_install" | "reachable" | "declared" | "failed" | "revoked";

export type RuntimeExposureCreateInput =
  /** Sans `slug`, openedbot tire lui-même `ohb-<hex>` sur sa zone gérée. */
  | { kind: "managed_cloudflare"; slug?: string }
  /** Le client OAuth du tailnet, le temps d'une requête, jamais stocké. */
  | { kind: "tailscale_funnel"; slug: string; oauthClientId: string; oauthClientSecret: string };

/** Aucun secret : ni jeton d'installation, ni service token, ni token API. */
export type RuntimeExposureDto = {
  id: string;
  kind: RuntimeExposureStoredKind;
  status: RuntimeExposureStatus;
  hostname: string;
  /** L'URL HTTPS du gateway telle que `runtimes.endpoint` la portera. */
  endpoint: string;
  runtimeId: string | null;
  /** Access Service Auth posé (Cloudflare) ; toujours faux pour Funnel. */
  edgeAuthProvisioned: boolean;
  /** `healthy | down | inactive` chez Cloudflare ; `reachable | unreachable` pour Funnel ; `null` avant la première lecture. */
  lastTunnelStatus: string | null;
  lastCheckedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};

/**
 * Réponse de la création : le DTO plus LA commande à jouer sur l'hôte, rendue
 * une seule fois (elle porte le jeton d'installation pour Cloudflare). Les
 * étapes qui l'entourent (installer le paquet, vérifier le service) sont du
 * ressort de l'écran, sans secret.
 */
export type RuntimeExposureCreatedDto = {
  exposure: RuntimeExposureDto;
  installCommand: string;
};

/**
 * Les publications de l'organisation qui n'ont pas encore de runtime : celles
 * qu'un dialogue fermé trop tôt laisserait invisibles alors qu'elles tiennent
 * un tunnel, un DNS et une application Access chez le fournisseur.
 */
export type RuntimeExposureListDto = { exposures: RuntimeExposureDto[] };

/**
 * `cloudflareCleanup: "manual"` : la publication est révoquée chez openedbot mais ce
 * qu'elle a créé chez le fournisseur reste en place, faute d'identifiants pour
 * le retirer. `"none"` : il n'y avait rien à retirer.
 */
export type RuntimeExposureRevokedDto = { ok: true; cloudflareCleanup: "done" | "manual" | "none" };

/** Corps de `POST /api/runtime/exposures/:id/declare` : nom et bearer ; Access vient de l'exposition. */
export type RuntimeExposureDeclareInput = { name: string; token: string };
