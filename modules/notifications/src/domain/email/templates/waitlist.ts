import type { EmailBlock } from "../design";
import { accessTierLabel, discordSupportBlocks, loginButton, text, waitlistBanner, type TemplateFamily } from "./helpers";

/** La liste d'attente : confirmation, accès accordé, changé ou retiré. */
export const WAITLIST_TEMPLATES = {
  /**
   * L'accusé de la liste d'attente. Il ne promet qu'une chose, celle que la
   * page publique affiche sous le champ : un seul message de plus, à
   * l'ouverture. Aucun bouton vers la console, elle n'est pas ouverte, c'est
   * tout le sujet.
   *
   * Et AUCUN lien légal, comme tous les autres genres depuis. Les mentions et
   * la politique de confidentialité ne sont pas encore écrites : ce que le rôle
   * pose sur la VM est un texte d'attente. Envoyer au public un lien vers une
   * page qui n'a pas de contenu vaut moins que ne pas la lier du tout. Le
   * rendu sait toujours poser un pied de page de liens (`footerLinks`,
   * `design.ts`) : le jour où ces pages existent, il n'y a qu'à le remplir.
   */
  waitlist_confirmation: {
    fr: (data) => ({
      subject: "Votre place sur la liste d’attente openedbot",
      preheader: "Un seul message de plus, à l’ouverture. Rien d’autre.",
      blocks: [
        ...waitlistBanner(data, ""),
        { kind: "heading", text: "Vous êtes sur la liste" },
        { kind: "paragraph", text: "Votre adresse est enregistrée sur la liste d’attente d’openedbot." },
        { kind: "paragraph", text: "Vous recevrez un seul message de plus, à l’ouverture. Rien d’autre." },
        { kind: "divider" },
        {
          kind: "note",
          text: "Vous n’êtes pas à l’origine de cette inscription ? Ignorez ce message : l’adresse sera retirée faute de confirmation à l’ouverture.",
        },
      ],
      footerReason: "Vous recevez ce message parce que cette adresse a été inscrite sur la liste d’attente d’openedbot.",
    }),
    en: (data) => ({
      subject: "Your place on the openedbot waiting list",
      preheader: "One more message, when it opens. Nothing else.",
      blocks: [
        ...waitlistBanner(data, ""),
        { kind: "heading", text: "You are on the list" },
        { kind: "paragraph", text: "Your address is recorded on the openedbot waiting list." },
        { kind: "paragraph", text: "You will get one more message, when it opens. Nothing else." },
        { kind: "divider" },
        {
          kind: "note",
          text: "Did not sign up? Ignore this message: the address is dropped without a confirmation at opening.",
        },
      ],
      footerReason: "You are getting this message because this address was added to the openedbot waiting list.",
    }),
  },
  /**
   * Le SEUL message promis par l'accusé d'inscription : « à l'ouverture ».
   * Il ne dit pas sous quel mode l'accès a été accordé (`alpha`, `beta`,
   * `classic`) : c'est un mot d'équipe, il ne change rien à ce que la personne
   * a à faire, et il n'ouvre pas trois portes différentes.
   *
   * Il ne nomme pas non plus la porte : le bouton mène à /login, et c'est
   * l'écran de connexion qui montre par où l'on entre. Un message qui décrit
   * un moyen d'authentification vieillit mal, et il vieillit chez la personne,
   * dans une boîte aux lettres que nous ne pouvons pas corriger.
   */
  /**
   * L'accès est ouvert, et le message porte de quoi ENTRER.
   *
   * Depuis le 2026-09-10, toute ouverture d'accès pose un mot de passe
   * temporaire neuf sur le compte visé (`staff-waitlist-routes.ts`) : une
   * personne qui reçoit « votre accès est ouvert » sans rien pour se connecter
   * se retrouve devant une porte qu'on lui dit ouverte, et c'est arrivé.
   *
   * Le mot de passe reste FACULTATIF dans la charge utile : un compte qui
   * n'entre que par Google n'en reçoit pas, et le message se replie alors sur
   * sa forme d'origine. Les deux notes de bas de message diffèrent, parce
   * qu'elles ne promettent pas la même chose.
   */
  waitlist_access_granted: {
    fr: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "Votre accès à openedbot est ouvert",
        preheader: temporaryPassword
          ? "Votre adresse est validée : voici de quoi vous connecter."
          : "Votre adresse est validée : vous pouvez entrer.",
        blocks: [
          ...waitlistBanner(data, ""),
          { kind: "heading", text: "Votre accès est ouvert" },
          { kind: "paragraph", text: "Votre adresse a été validée : vous pouvez entrer dans openedbot." },
          ...(temporaryPassword
            ? ([{
                kind: "rows",
                rows: [
                  ...(email ? ([["Adresse", email]] as Array<[string, string]>) : []),
                  ["Mot de passe temporaire", temporaryPassword],
                ],
              }] as EmailBlock[])
            : []),
          ...loginButton(data, "Se connecter"),
          ...discordSupportBlocks(
            "Une question, un blocage ? Le support se fait sur notre Discord : c’est là qu’on ouvre un ticket.",
            "Rejoindre le Discord",
          ),
          { kind: "divider" },
          {
            kind: "note",
            // Le message ne dit pas la même chose selon qu'il porte ou non de
            // quoi entrer. Promettre « aucun compte n'est créé » sous un mot de
            // passe qui vient d'être posé serait faux.
            text: temporaryPassword
              ? "Ce mot de passe est temporaire : à la connexion, openedbot vous demande d’en choisir un autre avant d’ouvrir l’application. Toute session encore ouverte a été fermée, et le mot de passe précédent ne fonctionne plus. Ne le transmettez à personne."
              : "Vous ne vous êtes jamais inscrit à openedbot ? Ignorez ce message : sans connexion de votre part, aucun compte n’est créé.",
          },
        ],
        footerReason: "Vous recevez ce message parce que cette adresse était sur la liste d’attente d’openedbot.",
      };
    },
    en: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "Your openedbot access is open",
        preheader: temporaryPassword
          ? "Your address is approved: here is what you need to sign in."
          : "Your address is approved: you can come in.",
        blocks: [
          ...waitlistBanner(data, ""),
          { kind: "heading", text: "Your access is open" },
          { kind: "paragraph", text: "Your address has been approved: you can come into openedbot." },
          ...(temporaryPassword
            ? ([{
                kind: "rows",
                rows: [
                  ...(email ? ([["Address", email]] as Array<[string, string]>) : []),
                  ["Temporary password", temporaryPassword],
                ],
              }] as EmailBlock[])
            : []),
          ...loginButton(data, "Sign in"),
          ...discordSupportBlocks(
            "Have a question or got stuck? Support happens on our Discord: that's where we open a ticket.",
            "Join the Discord",
          ),
          { kind: "divider" },
          {
            kind: "note",
            text: temporaryPassword
              ? "This password is temporary: on sign-in, openedbot asks you to choose another one before opening the app. Any session still open has been closed, and the previous password no longer works. Do not share it with anyone."
              : "Never signed up for openedbot? Ignore this message: without a sign-in from you, no account is created.",
          },
        ],
        footerReason: "You are getting this message because this address was on the openedbot waiting list.",
      };
    },
  },
  /**
   * Le mode a changé sur un accès DÉJÀ ouvert.
   *
   * Celui-là nomme le mode, contrairement au message d'ouverture, et pour une
   * raison simple : c'est la seule chose qu'il annonce. Un message qui dirait
   * « votre accès a changé » sans dire en quoi ne vaudrait pas la peine d'être
   * reçu. Le mot est donc rendu dans la langue de la personne
   * (`accessTierLabel`), jamais l'identifiant technique.
   *
   * Il ne promet rien d'autre : les trois modes ouvrent aujourd'hui la même
   * chose, et le message ne prétend pas le contraire.
   */
  waitlist_access_tier_changed: {
    fr: (data) => {
      const tier = accessTierLabel(data.tier, "fr");
      return {
        subject: "Votre accès à openedbot a changé de mode",
        preheader: `Votre accès est désormais en mode ${tier}.`,
        blocks: [
          ...waitlistBanner(data, ""),
          { kind: "heading", text: "Votre mode d’accès a changé" },
          { kind: "paragraph", text: `Votre accès à openedbot est désormais en mode ${tier}.` },
          { kind: "paragraph", text: "Votre accès reste ouvert : il n’y a rien à refaire de votre côté." },
          ...loginButton(data, "Ouvrir openedbot"),
        ],
        footerReason: "Vous recevez ce message parce que votre accès à openedbot a été modifié.",
      };
    },
    en: (data) => {
      const tier = accessTierLabel(data.tier, "en");
      return {
        subject: "Your openedbot access mode has changed",
        preheader: `Your access is now on the ${tier} mode.`,
        blocks: [
          ...waitlistBanner(data, ""),
          { kind: "heading", text: "Your access mode has changed" },
          { kind: "paragraph", text: `Your openedbot access is now on the ${tier} mode.` },
          { kind: "paragraph", text: "Your access stays open: there is nothing to redo on your side." },
          ...loginButton(data, "Open openedbot"),
        ],
        footerReason: "You are getting this message because your openedbot access was changed.",
      };
    },
  },
  /**
   * L'accès est retiré.
   *
   * Deux choses à dire, et pas une de plus : la porte est refermée, et un
   * compte DÉJÀ créé n'est pas touché (le retrait vise l'inscription, pas le
   * compte : `staff-waitlist-routes.ts`). Taire la seconde laisserait croire à
   * une suppression de compte qui n'a pas eu lieu.
   *
   * Aucun bouton : il n'y a rien à ouvrir. Un « Se connecter » sur un accès
   * retiré serait une invitation à se heurter à un refus.
   */
  waitlist_access_revoked: {
    fr: (data) => ({
      subject: "Votre accès à openedbot a été retiré",
      preheader: "L’ouverture accordée à cette adresse a été annulée.",
      blocks: [
        ...waitlistBanner(data, ""),
        { kind: "heading", text: "Votre accès a été retiré" },
        { kind: "paragraph", text: "L’ouverture accordée à cette adresse a été annulée : elle ne permet plus de créer de compte openedbot." },
        { kind: "paragraph", text: "Si vous aviez déjà créé votre compte, il n’est pas concerné : ce retrait ne ferme que la création d’un nouveau compte." },
        { kind: "divider" },
        { kind: "note", text: "Votre adresse reste sur la liste d’attente ; une nouvelle ouverture vous serait annoncée par un message comme celui-ci." },
      ],
      footerReason: "Vous recevez ce message parce que votre accès à openedbot a été modifié.",
    }),
    en: (data) => ({
      subject: "Your openedbot access has been revoked",
      preheader: "The opening granted to this address has been cancelled.",
      blocks: [
        ...waitlistBanner(data, ""),
        { kind: "heading", text: "Your access has been revoked" },
        { kind: "paragraph", text: "The opening granted to this address has been cancelled: it no longer allows an openedbot account to be created." },
        { kind: "paragraph", text: "If you had already created your account, it is untouched: this only closes the creation of a new account." },
        { kind: "divider" },
        { kind: "note", text: "Your address stays on the waiting list; a new opening would be announced by a message like this one." },
      ],
      footerReason: "You are getting this message because your openedbot access was changed.",
    }),
  },
} satisfies TemplateFamily;
