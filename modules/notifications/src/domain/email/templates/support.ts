import { text, type TemplateFamily } from "./helpers";

/** Le support : une nouvelle conversation pour l'équipe. */
export const SUPPORT_TEMPLATES = {
  /**
   * L'avis au staff qu'un visiteur vient d'ouvrir un fil.
   *
   * Il ne porte AUCUN contenu de message, seulement l'adresse du visiteur et
   * le lien vers le fil. Un guichet se lit dans le backoffice, pas dans une
   * boîte aux lettres : recopier le texte ici en ferait une seconde copie à
   * purger, hors de la rétention du fil.
   *
   * En français seulement dans les faits : le staff lit son backoffice en
   * français. La version anglaise existe parce que le contrat de genre l'exige
   * et que `templates.test.ts` la vérifie, pas parce qu'un tiers la demande.
   */
  support_new_conversation: {
    fr: (data) => {
      const guestEmail = text(data.guestEmail) || "adresse inconnue";
      const conversationUrl = text(data.conversationUrl);
      return {
        subject: `Nouveau fil de support : ${guestEmail}`,
        preheader: "Un visiteur attend une réponse dans le backoffice.",
        blocks: [
          { kind: "heading", text: "Un visiteur vous écrit" },
          { kind: "paragraph", text: `${guestEmail} a ouvert un fil de support.` },
          ...(conversationUrl
            ? [{ kind: "button", label: "Ouvrir le fil", url: conversationUrl } as const]
            : []),
          { kind: "divider" },
          {
            kind: "note",
            text: "Ce message ne contient pas le texte du visiteur : il se lit dans le backoffice, et se purge avec le fil.",
          },
        ],
        footerReason: "Vous recevez ce message parce que cette adresse est un compte staff actif d’openedbot.",
      };
    },
    en: (data) => {
      const guestEmail = text(data.guestEmail) || "unknown address";
      const conversationUrl = text(data.conversationUrl);
      return {
        subject: `New support thread: ${guestEmail}`,
        preheader: "A visitor is waiting for an answer in the backoffice.",
        blocks: [
          { kind: "heading", text: "A visitor is writing to you" },
          { kind: "paragraph", text: `${guestEmail} opened a support thread.` },
          ...(conversationUrl
            ? [{ kind: "button", label: "Open the thread", url: conversationUrl } as const]
            : []),
          { kind: "divider" },
          {
            kind: "note",
            text: "This message carries no visitor text: it is read in the backoffice, and purged with the thread.",
          },
        ],
        footerReason: "You are getting this message because this address is an active openedbot staff account.",
      };
    },
  },
} satisfies TemplateFamily;
