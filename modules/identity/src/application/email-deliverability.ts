import { HttpError } from "@openedbot/contracts-errors/http-error";
import { logEvent } from "@openedbot/platform-observability";
import { isDisposableEmailDomain } from "../domain/disposable-email-domains";
import { emailDomain } from "../domain/email-address";
import { createEmailDomainChecker, type EmailDomainResolver } from "./email-domain-check";

/**
 * Une adresse d'invitation doit pouvoir recevoir le courrier qu'on va lui
 * envoyer : la forme ne suffit pas. `dupont@gmail.co` est bien formée, et
 * `gmail.co` publie un Null MX (RFC 7505) : l'e-mail ne partira jamais.
 *
 * La chaîne est celle de la liste d'attente et du guichet support :
 * domaine jetable, puis DNS (MX, sinon adresse IP). Un résolveur qui ne
 * répond pas laisse passer et se journalise (`*.domain_check_failed`, niveau
 * warn) : une panne d'infrastructure n'est pas une raison de refuser
 * l'adresse d'un collègue.
 */
let defaultChecker: EmailDomainResolver | null = null;

/** Une instance par processus : le cache DNS n'a d'intérêt que partagé. */
export function defaultEmailDomainChecker(): EmailDomainResolver {
  defaultChecker ??= createEmailDomainChecker();
  return defaultChecker;
}

export async function assertEmailDeliverable(
  email: string,
  checkDomain: EmailDomainResolver,
  /** Le préfixe du journal : `member_invitation`, `agency_invitation`. */
  context: string,
): Promise<void> {
  const domain = emailDomain(email);
  if (isDisposableEmailDomain(domain)) {
    throw new HttpError(
      400,
      "EMAIL_DISPOSABLE",
      "Les adresses jetables ne sont pas acceptées : utilisez une adresse que la personne relève.",
    );
  }
  const verdict = await checkDomain(domain);
  if (verdict === "unknown_domain") {
    throw new HttpError(400, "EMAIL_DOMAIN_UNKNOWN", "Ce domaine ne reçoit pas de courrier : vérifiez l’adresse.");
  }
  if (verdict === "unverified") {
    logEvent(`${context}.domain_check_failed`, { domain });
  }
}
