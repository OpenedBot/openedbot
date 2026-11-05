import { Hono } from "hono";
import type { WaitlistJoinDto } from "@openedbot/contracts-api";
import { emailDomain, isEmailSyntaxValid, MAX_EMAIL_LENGTH, normalizeEmail } from "@openedbot/identity/domain/email-address";
import { createEmailDomainChecker, type EmailDomainResolver } from "@openedbot/identity/application/email-domain-check";
import { enqueueTransactionalEmail, recordTransactionalEmailEvent } from "@openedbot/notifications/application/transactional-email";
import { isDisposableEmailDomain } from "@openedbot/identity/domain/disposable-email-domains";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { logEvent } from "@openedbot/platform-observability";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";

/**
 * `POST /api/waitlist` : l'inscription à la liste d'attente depuis la page
 * publique `/`. Sans session, hors tenant, plafonnée par `API_RATE_RULES`.
 *
 * Trois contrôles, du moins cher au plus cher, chacun avec son refus nommé :
 *
 *  1. **la forme** (`@openedbot/identity/domain/email-address`) : la même règle que celle
 *     appliquée dans le champ de la PWA, donc aucun refus surprise après coup ;
 *  2. **le domaine jetable** : une liste embarquée, sans réseau ;
 *  3. **la livrabilité du domaine** : une résolution DNS (MX, puis adresse IP
 *     en repli). Une panne de résolution LAISSE PASSER : voir
 *     `email-domain-check.ts`, refuser sur un aléa d'infrastructure perdrait
 *     des inscriptions sans que personne ne le voie.
 *
 * Aucun des trois ne prouve qu'une boîte existe derrière l'adresse. Seule la
 * confirmation demandée à l'ouverture le fera.
 *
 * L'adresse est la clé : une seconde inscription de la même adresse répond
 * `already`, sans erreur, et n'écrit rien. La route publique ne relit jamais
 * la liste et sa réponse ne dit pas plus que ce que la personne vient de taper.
 *
 * La route publique ne fait AUCUNE lecture, ni ici ni sur la file d'e-mails,
 * car les deux tables portent des adresses en clair. Le rôle `openedbot_api` peut
 * lire la liste pour les routes staff depuis 0066, mais ce handler conserve la
 * discipline d'écriture seule de 0065 : `on conflict do nothing` sans cible et
 * aucun `returning`. Le nombre de lignes écrites suffit à distinguer une
 * inscription neuve d'un doublon sans exposer la liste au chemin public.
 *
 * L'accusé part dans la MÊME transaction que l'inscription : un e-mail en
 * file sans ligne dans la liste serait une promesse sans inscrit, et une
 * inscription sans accusé un silence qu'aucune passe ne rattrape. L'envoi,
 * lui, appartient au worker : la requête HTTP ne parle à aucun fournisseur.
 */
export function waitlistRoutes(
  db: Db,
  config: ApiConfig,
  /** Injecté par les tests : sans lui, chaque cas sortirait sur le DNS réel. */
  checkDomain: EmailDomainResolver = createEmailDomainChecker(),
): Hono {
  const routes = new Hono();

  routes.post("/", async (context) => {
    const body = await jsonBody(context.req.raw);
    const email = normalizeEmail(assertString(body.email, "L’adresse email", { max: MAX_EMAIL_LENGTH }));
    if (!isEmailSyntaxValid(email)) {
      throw new HttpError(400, "WAITLIST_EMAIL_INVALID", "Entrez une adresse e-mail valide.");
    }

    const domain = emailDomain(email);
    if (isDisposableEmailDomain(domain)) {
      throw new HttpError(
        400,
        "WAITLIST_EMAIL_DISPOSABLE",
        "Les adresses jetables ne sont pas acceptées : utilisez une adresse que vous relevez.",
      );
    }

    const verdict = await checkDomain(domain);
    if (verdict === "unknown_domain") {
      throw new HttpError(
        400,
        "WAITLIST_EMAIL_DOMAIN_UNKNOWN",
        "Ce domaine ne reçoit pas de courrier : vérifiez l’adresse.",
      );
    }
    if (verdict === "unverified") {
      // Laissé passer, mais dit.
      // Le suffixe `_failed` porte le niveau `warn` (`logEvent`) : une série de
      // ces lignes signale un résolveur en panne, pas des inscriptions douteuses.
      logEvent("waitlist.domain_check_failed", { domain });
    }

    const locale = body.locale === "fr" || body.locale === "en" ? body.locale : null;

    const joined = await db.begin(async (tx: Db) => {
      const id = crypto.randomUUID();
      const inserted = await tx`
        insert into waitlist_signups (id, email, locale)
        values (${id}, ${email}, ${locale})
        on conflict do nothing
      `;
      if (inserted.count < 1) return false;
      // La clé protège un double dépôt du même événement lors d'un rejeu de
      // requête. Une réinscription après suppression est un événement neuf et
      // mérite son accusé : c'est le silence qui a manqué le 2026-09-08.
      const outboxId = await enqueueTransactionalEmail(tx, {
        kind: "waitlist_confirmation",
        dedupeKey: `waitlist:${id}`,
        recipientEmail: email,
        locale: locale ?? "fr",
        // L'origine de la PWA : le worker n'invente pas d'URL publique, c'est
        // elle qui donne au pied de page ses liens légaux.
        payload: { webAppUrl: config.webUrl },
      });
      if (outboxId) {
        await recordTransactionalEmailEvent(tx, {
          outboxId,
          kind: "waitlist_confirmation",
          event: "queued",
        });
      } else {
        await recordTransactionalEmailEvent(tx, {
          outboxId: null,
          kind: "waitlist_confirmation",
          event: "duplicate_skipped",
          detail: { domain },
        });
        // Le suffixe `_failed` porte le niveau `warn` dans `logEvent` : un
        // accusé non déposé reste visible sans modifier la réponse publique.
        logEvent("waitlist.confirmation_enqueue_failed", { domain });
      }
      return true;
    }) as boolean;

    const result: WaitlistJoinDto = { status: joined ? "joined" : "already" };
    return context.json(result, joined ? 201 : 200);
  });

  return routes;
}
