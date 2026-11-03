import { resolve4, resolve6, resolveMx } from "node:dns/promises";

/**
 * Le domaine d'une adresse peut-il recevoir du courrier ?
 *
 * La question est posée au DNS, et elle n'a que trois réponses possibles :
 *
 * - `deliverable` : le domaine annonce un MX, ou à défaut une adresse IP.
 *   La RFC 5321 §5.1 l'impose : sans MX, un domaine qui a un A ou un AAAA
 *   reste une destination valide, et beaucoup de petits domaines vivent comme
 *   ça. Ne regarder que le MX les rejetterait à tort.
 * - `unknown_domain` : le DNS a répondu, et il a répondu que ce nom n'existe
 *   pas, ou qu'il n'a aucun enregistrement. C'est la seule réponse qui
 *   justifie de refuser une inscription.
 * - `unverified` : le DNS n'a pas répondu, a échoué, ou a mis trop longtemps.
 *
 * **`unverified` laisse passer.** C'est une décision, pas un oubli : une
 * panne de résolveur, un serveur DNS lent ou une coupure réseau ne sont pas
 * des raisons de refuser l'adresse de quelqu'un. Fermer la porte sur un aléa
 * d'infrastructure transformerait une panne invisible en perte d'inscriptions
 * silencieuse. Le cas est journalisé par l'appelant, pas dissimulé.
 *
 * Ce module ne dit RIEN de la boîte elle-même : un domaine livrable peut très
 * bien rejeter l'adresse. Seul un message envoyé le prouve, et c'est le rôle
 * de la confirmation demandée à l'ouverture.
 */
export type EmailDomainVerdict = "deliverable" | "unknown_domain" | "unverified";

/** Ce qui vient du DNS lui-même, injectable pour que les tests ne sortent pas de la machine. */
export type EmailDomainResolver = (domain: string) => Promise<EmailDomainVerdict>;

/** Au-delà, on n'attend plus : une inscription ne peut pas dépendre d'un résolveur lent. */
const LOOKUP_TIMEOUT_MS = 3_000;
/** Un domaine livrable le reste ; inutile de redemander à chaque inscription. */
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1_000;
/** Un domaine inconnu peut naître dans l'heure : on redemande plus vite. */
const NEGATIVE_TTL_MS = 10 * 60 * 1_000;
/** Borne du cache : un formulaire public est aussi un moyen de faire grossir une Map. */
const CACHE_MAX_ENTRIES = 2_000;

/**
 * Les codes qui veulent dire « ce nom n'existe pas » ou « il n'a rien ».
 * Tout le reste (`ESERVFAIL`, `ETIMEOUT`, `ECONNREFUSED`…) est une panne de
 * résolution, pas un verdict sur le domaine.
 */
const DEFINITIVE_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

type CacheEntry = { verdict: EmailDomainVerdict; expiresAt: number };

/**
 * Construit un vérificateur avec son cache. Une instance par processus : le
 * cache n'a d'intérêt que partagé entre les requêtes.
 */
export function createEmailDomainChecker(
  resolver: EmailDomainResolver = resolveDomainDeliverability,
  now: () => number = Date.now,
): EmailDomainResolver {
  const cache = new Map<string, CacheEntry>();

  return async (domain: string): Promise<EmailDomainVerdict> => {
    const key = domain.trim().toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.verdict;

    const verdict = await resolver(key);
    // Une panne ne se met pas en cache : la prochaine tentative doit redemander.
    if (verdict !== "unverified") {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cache.set(key, {
        verdict,
        expiresAt: now() + (verdict === "deliverable" ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      });
    }
    return verdict;
  };
}

/** La résolution réelle : MX d'abord, adresse IP en repli, comme la RFC le demande. */
export async function resolveDomainDeliverability(domain: string): Promise<EmailDomainVerdict> {
  const mx = await lookup(() => resolveMx(domain));
  if (mx.kind === "found") {
    // Un MX « . » est le refus explicite de recevoir du courrier (RFC 7505).
    const usable = mx.records.some((record) => record.exchange.trim() !== "" && record.exchange.trim() !== ".");
    return usable ? "deliverable" : "unknown_domain";
  }
  if (mx.kind === "failed") return "unverified";

  // Pas de MX : le domaine reste joignable s'il a une adresse (RFC 5321 §5.1).
  const [v4, v6] = await Promise.all([
    lookup(() => resolve4(domain)),
    lookup(() => resolve6(domain)),
  ]);
  if (v4.kind === "found" || v6.kind === "found") return "deliverable";
  if (v4.kind === "failed" || v6.kind === "failed") return "unverified";
  return "unknown_domain";
}

type LookupOutcome<T> =
  | { kind: "found"; records: T[] }
  /** Le DNS a répondu : ce nom n'existe pas, ou n'a pas cet enregistrement. */
  | { kind: "empty" }
  /** Le DNS n'a pas répondu, ou a échoué pour une raison passagère. */
  | { kind: "failed" };

async function lookup<T>(query: () => Promise<T[]>): Promise<LookupOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), LOOKUP_TIMEOUT_MS);
    });
    const outcome = await Promise.race([query(), timeout]);
    if (outcome === "timeout") return { kind: "failed" };
    return outcome.length > 0 ? { kind: "found", records: outcome } : { kind: "empty" };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    return DEFINITIVE_CODES.has(code) ? { kind: "empty" } : { kind: "failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
