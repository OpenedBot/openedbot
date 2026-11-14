/**
 * Les domaines de boîtes jetables refusés à l'inscription.
 *
 * Cette liste vit côté API SEULEMENT. L'embarquer dans le bundle du
 * navigateur ferait payer à chaque visiteur un refus que le serveur doit de
 * toute façon reprononcer.
 *
 * Ce qu'elle est : les services de courrier temporaire les plus courants,
 * ceux qu'on rencontre vraiment sur un formulaire public. Chaque entrée est
 * un service dont la raison d'être est de fournir une adresse qu'on abandonne.
 *
 * Ce qu'elle n'est PAS : exhaustive. De nouveaux domaines apparaissent chaque
 * jour, et une liste de trois mille entrées donnerait surtout l'illusion de
 * l'être. Le vrai filtre reste la confirmation demandée à l'ouverture : une
 * adresse que personne ne relit ne la franchit pas, qu'elle soit listée ici ou
 * non. Cette liste écarte le bruit évident, elle ne prétend pas à davantage.
 *
 * Règle d'ajout : uniquement un service de courrier temporaire. Jamais un
 * fournisseur grand public (`gmail.com`, `laposte.net`, `free.fr`,
 * `orange.fr`, `gmx.de`, `mail.ru`), jamais un domaine d'entreprise. Un faux
 * positif ici, c'est une personne qui ne peut pas s'inscrire et qui n'a aucun
 * moyen de le comprendre.
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // 1secmail et ses rotations
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "esiix.com",
  "ezztt.com",
  "icznn.com",
  "kzccv.com",
  "qiott.com",
  "vjuum.com",
  "wuuvo.com",
  "xojxe.com",
  "yoggm.com",
  // 10 minute mail et voisins
  "10minemail.com",
  "10minutemail.co.uk",
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "minuteinbox.com",
  // Guerrilla Mail
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "pokemail.net",
  "sharklasers.com",
  "spam4.me",
  // Mailinator et ses alias
  "binkmail.com",
  "bobmail.info",
  "chammy.info",
  "devnullmail.com",
  "letthemeatspam.com",
  "mailin8r.com",
  "mailinater.com",
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "notmailinator.com",
  "reallymymail.com",
  "reconmail.com",
  "safetymail.info",
  "sogetthis.com",
  "spamherelots.com",
  "suremail.info",
  "thisisnotmyrealemail.com",
  "tradermail.info",
  "veryrealemail.com",
  "zippymail.info",
  // Temp Mail et dérivés
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempemail.net",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailaddress.com",
  "tempmailer.de",
  "tempmailo.com",
  "tempr.email",
  "tmpmail.net",
  "tmpmail.org",
  // Trash Mail et la famille germanophone
  "byom.de",
  "mailexpire.com",
  "mailhole.de",
  "sofort-mail.de",
  "spamfree24.de",
  "spamfree24.org",
  "trash-mail.com",
  "trash-mail.de",
  "trashmail.com",
  "trashmail.de",
  "trashmail.me",
  "trashmail.net",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "wegwerfmail.org",
  // Yopmail et ses miroirs
  "courriel.fr.nf",
  "jetable.fr.nf",
  "jetable.org",
  "mail-temporaire.fr",
  "moncourrier.fr.nf",
  "monemail.fr.nf",
  "monmail.fr.nf",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  // Le reste, par ordre alphabétique
  "anonaddy.me",
  "burnermail.io",
  "discard.email",
  "discardmail.com",
  "discardmail.de",
  "dispostable.com",
  "dropmail.me",
  "emailfake.com",
  "emailondeck.com",
  "fakeinbox.com",
  "fakemailgenerator.com",
  "getairmail.com",
  "getnada.com",
  "harakirimail.com",
  "inboxbear.com",
  "inboxkitten.com",
  "luxusmail.org",
  "mail7.io",
  "mailcatch.com",
  "maildrop.cc",
  "mailnesia.com",
  "mailpoof.com",
  "mailsac.com",
  "mailtemp.info",
  "moakt.com",
  "mohmal.com",
  "mt2015.com",
  "mytrashmail.com",
  "nada.email",
  "spambog.com",
  "spambog.de",
  "spambog.ru",
  "spamgourmet.com",
  "thankyou2010.com",
  "throwaway.email",
  "throwawaymail.com",
]);

/**
 * `true` si le domaine est une boîte jetable connue.
 *
 * Le suffixe compte autant que le domaine exact : `boite.yopmail.com` n'est
 * pas moins jetable que `yopmail.com`, et certains de ces services servent
 * chacun de leurs utilisateurs sur un sous-domaine.
 */
export function isDisposableEmailDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase();
  if (!value) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(value)) return true;
  for (const listed of DISPOSABLE_EMAIL_DOMAINS) {
    if (value.endsWith(`.${listed}`)) return true;
  }
  return false;
}
