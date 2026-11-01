import { loginButton, text, type TemplateFamily } from "./helpers";

/** Les comptes du backoffice : création, mot de passe, code de connexion. */
export const STAFF_TEMPLATES = {
  /**
   * L'équipe a créé un compte pour cette adresse, depuis le backoffice, avec un
   * mot de passe TEMPORAIRE. Le message doit donc porter la seule chose qui ne
   * se devine pas, ce mot de passe, et dire tout de suite qu'il ne survivra pas
   * à la première connexion : l'application le fait changer avant de laisser
   * entrer (`users.must_change_password`).
   *
   * L'adresse est rappelée en clair : un compte créé PAR QUELQU'UN D'AUTRE
   * arrive sans avoir été demandé, et la personne doit pouvoir vérifier de quel
   * compte on lui parle avant de taper quoi que ce soit.
   *
   * Pas de bandeau : ce n'est pas une annonce de liste d'attente mais un
   * courrier de compte, et il se lit en trois lignes.
   */
  staff_account_created: {
    fr: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "Votre compte openedbot est prêt",
        preheader: "Un mot de passe temporaire, à changer dès la première connexion.",
        blocks: [
          { kind: "heading", text: "Votre compte a été créé" },
          { kind: "paragraph", text: "L’équipe openedbot a créé votre compte. Voici de quoi vous connecter une première fois." },
          {
            kind: "rows",
            rows: [
              ...(email ? ([["Adresse", email]] as Array<[string, string]>) : []),
              ["Mot de passe temporaire", temporaryPassword],
            ],
          },
          ...loginButton(data, "Se connecter"),
          { kind: "divider" },
          {
            kind: "note",
            text: "Ce mot de passe est temporaire : à la première connexion, openedbot vous demande d’en choisir un autre avant d’ouvrir l’application. Ne le transmettez à personne.",
          },
        ],
        footerReason: "Vous recevez ce message parce que l’équipe openedbot a créé un compte pour cette adresse.",
      };
    },
    en: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "Your openedbot account is ready",
        preheader: "A temporary password, to be changed on the first sign-in.",
        blocks: [
          { kind: "heading", text: "Your account has been created" },
          { kind: "paragraph", text: "The openedbot team created your account. Here is what you need for a first sign-in." },
          {
            kind: "rows",
            rows: [
              ...(email ? ([["Address", email]] as Array<[string, string]>) : []),
              ["Temporary password", temporaryPassword],
            ],
          },
          ...loginButton(data, "Sign in"),
          { kind: "divider" },
          {
            kind: "note",
            text: "This password is temporary: on the first sign-in, openedbot asks you to choose another one before opening the app. Do not share it with anyone.",
          },
        ],
        footerReason: "You are getting this message because the openedbot team created an account for this address.",
      };
    },
  },
  /**
   * L'équipe a POSÉ UN AUTRE mot de passe temporaire sur un compte qui existait
   * déjà (`POST /api/pro/staff/users/:userId/temporary-password`). C'est le message
   * du support : la personne n'a jamais reçu le premier courrier, ou l'a perdu.
   *
   * Il dit une chose que le courrier de création n'a pas à dire : l'ancien mot
   * de passe ne vaut plus rien, et toute session encore ouverte a été fermée.
   * Sans cette phrase, quelqu'un déconnecté au milieu de son travail chercherait
   * une panne là où il y a eu une décision.
   *
   * L'adresse est rappelée en clair, comme à la création : le message arrive
   * sans avoir été demandé, et il faut pouvoir vérifier de quel compte on parle.
   */
  staff_password_reset: {
    fr: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "Un nouveau mot de passe temporaire pour votre compte openedbot",
        preheader: "L’ancien ne fonctionne plus : celui-ci est à changer dès la connexion.",
        blocks: [
          { kind: "heading", text: "Votre mot de passe a été réinitialisé" },
          {
            kind: "paragraph",
            text: "L’équipe openedbot a posé un nouveau mot de passe temporaire sur votre compte. L’ancien ne fonctionne plus.",
          },
          {
            kind: "rows",
            rows: [
              ...(email ? ([["Adresse", email]] as Array<[string, string]>) : []),
              ["Mot de passe temporaire", temporaryPassword],
            ],
          },
          ...loginButton(data, "Se connecter"),
          { kind: "divider" },
          {
            kind: "note",
            text: "Toute session encore ouverte a été fermée : reconnectez-vous avec ce mot de passe. Il est temporaire, openedbot vous demande d’en choisir un autre avant d’ouvrir l’application. Ne le transmettez à personne.",
          },
        ],
        footerReason: "Vous recevez ce message parce que l’équipe openedbot a réinitialisé le mot de passe de ce compte.",
      };
    },
    en: (data) => {
      const email = text(data.email);
      const temporaryPassword = text(data.temporaryPassword);
      return {
        subject: "A new temporary password for your openedbot account",
        preheader: "The previous one no longer works: change this one as you sign in.",
        blocks: [
          { kind: "heading", text: "Your password has been reset" },
          {
            kind: "paragraph",
            text: "The openedbot team set a new temporary password on your account. The previous one no longer works.",
          },
          {
            kind: "rows",
            rows: [
              ...(email ? ([["Address", email]] as Array<[string, string]>) : []),
              ["Temporary password", temporaryPassword],
            ],
          },
          ...loginButton(data, "Sign in"),
          { kind: "divider" },
          {
            kind: "note",
            text: "Any session still open has been closed: sign in again with this password. It is temporary, and openedbot asks you to choose another one before opening the app. Do not share it with anyone.",
          },
        ],
        footerReason: "You are getting this message because the openedbot team reset the password of this account.",
      };
    },
  },
  /**
   * Code à 6 chiffres pour ouvrir le backoffice. Il ne contient rien d'autre :
   * pas de lien qui connecterait à la place de la personne, pas de mot de passe.
   * Dix minutes, une seule fois.
   */
  staff_login_code: {
    fr: (data) => {
      const code = text(data.code);
      const minutes = text(data.expiresInMinutes) || "10";
      return {
        subject: "Votre code de connexion au backoffice openedbot",
        preheader: `Il expire dans ${minutes} minutes.`,
        blocks: [
          { kind: "heading", text: "Votre code de connexion" },
          {
            kind: "paragraph",
            text: `Saisissez ce code dans le backoffice openedbot pour ouvrir votre session. Il expire dans ${minutes} minutes et ne sert qu’une fois.`,
          },
          { kind: "code", label: "Code", code },
          { kind: "divider" },
          {
            kind: "note",
            text: "Si vous n’avez pas demandé ce code, ignorez ce message. Personne de l’équipe ne vous le redemandera.",
          },
        ],
        footerReason: "Vous recevez ce message parce qu’une connexion au backoffice openedbot a été demandée pour cette adresse.",
      };
    },
    en: (data) => {
      const code = text(data.code);
      const minutes = text(data.expiresInMinutes) || "10";
      return {
        subject: "Your openedbot back office sign-in code",
        preheader: `It expires in ${minutes} minutes.`,
        blocks: [
          { kind: "heading", text: "Your sign-in code" },
          {
            kind: "paragraph",
            text: `Enter this code in the openedbot back office to open your session. It expires in ${minutes} minutes and works only once.`,
          },
          { kind: "code", label: "Code", code },
          { kind: "divider" },
          {
            kind: "note",
            text: "If you did not ask for this code, ignore this message. Nobody on the team will ask you to read it back.",
          },
        ],
        footerReason: "You are getting this message because a sign-in to the openedbot back office was requested for this address.",
      };
    },
  },
} satisfies TemplateFamily;
