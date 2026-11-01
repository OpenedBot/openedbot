import { text, type TemplateFamily } from "./helpers";

/** Le compte : purge, fermeture et code de connexion par e-mail. */
export const ACCOUNT_TEMPLATES = {
  account_purge_completed: {
    fr: (data) => {
      const purgedAt = text(data.purgedAt);
      return {
        subject: "Votre compte openedbot a été supprimé",
        preheader: "La suppression est définitive : plus aucune donnée de votre organisation n’est conservée.",
        blocks: [
          { kind: "heading", text: "Votre compte a été supprimé" },
          {
            kind: "paragraph",
            text: `Votre compte et les données de votre organisation ont été supprimés définitivement${purgedAt ? ` (${purgedAt})` : ""}.`,
          },
          { kind: "paragraph", text: "Il n’y a rien à faire : ce message clôt la demande." },
        ],
        footerReason: "Vous recevez ce message parce qu’un compte openedbot associé à cette adresse a été supprimé.",
      };
    },
    en: (data) => {
      const purgedAt = text(data.purgedAt);
      return {
        subject: "Your openedbot account has been deleted",
        preheader: "The deletion is permanent: none of your organization's data is kept.",
        blocks: [
          { kind: "heading", text: "Your account has been deleted" },
          {
            kind: "paragraph",
            text: `Your account and organization data have been permanently deleted${purgedAt ? ` (${purgedAt})` : ""}.`,
          },
          { kind: "paragraph", text: "There is nothing to do: this message closes the request." },
        ],
        footerReason: "You are getting this message because an openedbot account tied to this address was deleted.",
      };
    },
  },
  account_closure_notice: {
    fr: (data) => {
      const name = text(data.displayName);
      return {
        subject: "Votre compte openedbot va être supprimé",
        preheader: "openedbot.app fait peau neuve d’ici quelques jours.",
        blocks: [
          { kind: "heading", text: name ? `Bonjour ${name},` : "Bonjour," },
          { kind: "paragraph", text: "openedbot.app fait peau neuve d’ici quelques jours." },
          {
            kind: "paragraph",
            text: "À cette occasion, votre compte sera supprimé, ainsi que vos données personnelles.",
          },
          { kind: "paragraph", text: "Vous n’avez rien à faire. Merci d’avoir essayé openedbot." },
        ],
        footerReason: "Vous recevez ce message parce qu’un compte openedbot est associé à cette adresse.",
      };
    },
    en: (data) => {
      const name = text(data.displayName);
      return {
        subject: "Your openedbot account will be deleted",
        preheader: "openedbot.app is getting a makeover in a few days.",
        blocks: [
          { kind: "heading", text: name ? `Hello ${name},` : "Hello," },
          { kind: "paragraph", text: "openedbot.app is getting a makeover in a few days." },
          {
            kind: "paragraph",
            text: "As part of it, your account will be deleted, along with your personal data.",
          },
          { kind: "paragraph", text: "There is nothing you need to do. Thank you for trying openedbot." },
        ],
        footerReason: "You are getting this message because an openedbot account is tied to this address.",
      };
    },
  },
  email_login_code: {
    fr: (data) => {
      const code = text(data.code);
      const minutes = text(data.expiresInMinutes) || "10";
      return {
        subject: "Votre code de connexion à openedbot",
        preheader: `Il expire dans ${minutes} minutes.`,
        blocks: [
          { kind: "heading", text: "Votre code de connexion" },
          {
            kind: "paragraph",
            text: `Saisissez ce code dans openedbot pour ouvrir votre session. Il expire dans ${minutes} minutes et ne sert qu’une fois.`,
          },
          { kind: "code", label: "Code", code },
          { kind: "divider" },
          {
            kind: "note",
            text: "Si vous n’avez pas demandé ce code, ignorez ce message. Personne de l’équipe ne vous le redemandera.",
          },
        ],
        footerReason: "Vous recevez ce message parce qu’une connexion à openedbot a été demandée pour cette adresse.",
      };
    },
    en: (data) => {
      const code = text(data.code);
      const minutes = text(data.expiresInMinutes) || "10";
      return {
        subject: "Your openedbot sign-in code",
        preheader: `It expires in ${minutes} minutes.`,
        blocks: [
          { kind: "heading", text: "Your sign-in code" },
          {
            kind: "paragraph",
            text: `Enter this code in the openedbot application to open your session. It expires in ${minutes} minutes and works only once.`,
          },
          { kind: "code", label: "Code", code },
          { kind: "divider" },
          {
            kind: "note",
            text: "If you did not ask for this code, ignore this message. Nobody on the team will ask you to read it back.",
          },
        ],
        footerReason: "You are getting this message because a sign-in to the openedbot application was requested for this address.",
      };
    },
  },
} satisfies TemplateFamily;
