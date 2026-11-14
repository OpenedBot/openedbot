/** French strings, one file per domain: `messages.fr.ts` assembles them. */

export const relativeTime = {
  never: "jamais",
  seconds: "il y a {count} s",
  minutes: "il y a {count} min",
  hours: "il y a {count} h",
  days: "il y a {count} j",
} as const;

export const units = {
  byte: "o",
  kibibyte: "Kio",
  mebibyte: "Mio",
  gibibyte: "Gio",
  tebibyte: "Tio",
} as const;

export const common = {
  never: "Jamais",
  loading: "Chargement…",
  cancel: "Annuler",
  confirm: "Confirmer",
  close: "Fermer",
  retry: "Réessayer",
  workspaceAccessRevoked: "Vous n’avez plus accès à cet espace.",
} as const;

export const errorState = {
  unexpected: "Rechargez la page pour reprendre.",
  copyReference: "Copier la référence",
  referenceCopied: "Référence copiée",
  retry: "Réessayer",
  quit: "Quitter",
  /* The steps of a request's path, as the screen names them. */
  hopBrowser: "navigateur",
  hopApi: "API",
  hopRuntime: "runtime",
  transmit: "Il n’y a rien à réparer de votre côté. Cette référence désigne la ligne exacte du journal : transmettez-la.",
  /* A title and a path sentence per kind of failure. The title says what
     happened, the sentence says how far the request got: it is what
     screen readers read instead of the diagram. */
  offlineTitle: "Le cloud est injoignable",
  offlinePath: "La requête n’est pas partie : le navigateur n’a pas atteint l’API.",
  deniedTitle: "Accès refusé",
  deniedPath: "L’API a répondu, et elle refuse cet accès.",
  missingTitle: "Cet élément n’existe plus",
  missingPath: "L’API a répondu, et elle ne trouve pas ce qui est demandé.",
  refusedTitle: "Demande refusée",
  refusedPath: "L’API a répondu, et elle refuse la demande telle quelle.",
  upstreamTitle: "Le runtime n’a pas répondu",
  upstreamPath: "L’API a été atteinte ; c’est au-delà, vers le runtime, que la requête s’arrête.",
  faultTitle: "L’API a échoué",
  faultPath: "L’API a été atteinte, et c’est elle qui a échoué.",
  runtimeAnsweredPath: "Le runtime a été atteint, et c’est lui qui refuse.",
  /* Facts a screen adds to the card footer when it knows which runtime it is talking about. */
  factRuntime: "runtime",
  factState: "état",
  factChecked: "vérifié",
  crashTitle: "Cet écran s’est arrêté",
} as const;

export const notFound = {
  title: "Cette page n’existe pas",
  description: "L’adresse demandée ne correspond à aucun écran. Un lien a pu changer depuis, ou l’élément qu’il désignait a été supprimé.",
  home: "Retour à l’accueil",
  back: "Revenir en arrière",
} as const;

export const eventParts = {
  toolFallback: "outil",
  toolsCount: "{count} outils",
} as const;

/**
 * Human labels of the runtime's tools, by technical name (`payload.tool`).
 * Table consulted by `toolLabel` (`lib/thread-tools.ts`): an absent name is
 * rendered as bare monospace, never guessed.
 */
export const toolLabels = {
  terminal: "Exécute une commande",
  shell: "Exécute une commande",
  skill_view: "Consulte une skill",
  delegate_task: "Délègue une tâche",
  async_delegation: "Délègue en arrière-plan",
  subagent: "Lance un sous-agent",
  search: "Recherche sur le web",
  web_search: "Recherche sur le web",
  http: "Appelle une URL",
  read_file: "Lit un fichier",
  write_file: "Écrit un fichier",
  cat: "Lit un fichier",
  search_files: "Cherche dans les fichiers",
  skills_list: "Liste les skills",
  execute_code: "Exécute du code",
  web_extract: "Lit une page web",
} as const;

export const apiClient = {
  cloudUnavailable: "L’API cloud ne répond pas encore.",
  httpUnauthorized: "Session expirée : reconnecte-toi (HTTP {status}).",
  httpForbidden: "Action refusée par l’API (HTTP {status}).",
  httpNotFound: "Introuvable côté API (HTTP {status}).",
  httpTimeout: "L’API n’a pas répondu à temps (HTTP {status}).",
  httpRateLimited: "Trop de requêtes, réessaie dans un instant (HTTP {status}).",
  httpGateway: "L’API est injoignable ou redémarre (HTTP {status}).",
  httpServerError: "L’API a rencontré une erreur sans l’expliquer (HTTP {status}). Réessaie ; si ça persiste, regarde son journal.",
  httpRefused: "Requête refusée par l’API (HTTP {status}).",
  /** Client deadline exceeded, no HTTP status: a read is safe to retry. */
  readTimeout: "L’API n’a pas répondu à temps. Réessaie dans un instant.",
  /** A write without an answer may have gone through: do not blindly redo it. */
  writeTimeout: "L’API n’a pas répondu à temps : l’action a peut-être abouti. Vérifie avant de recommencer.",
  /** A success whose body is not JSON (proxy page, truncated answer). */
  invalidResponse: "Réponse illisible de l’API (HTTP {status}) : rien n’a été confirmé.",
} as const;

export const face = {
  /** The cat face (`shape: "chat"`): its eye styles and its job signs. */
  catEyes: {
    pill: "Yeux pilules",
    round: "Yeux ronds",
    happy: "Yeux rieurs",
    square: "Yeux carrés",
  },
  catSigns: {
    none: "Aucun signe",
    antenna: "Antenne",
    glasses: "Lunettes",
    waves: "Ondes",
    sprout: "Pousse",
    headset: "Casque",
    gear: "Engrenage",
  },
  shapes: {
    cercle: "Cercle",
    galet: "Galet",
    squircle: "Squircle",
    capsule: "Capsule",
    triangle: "Triangle",
    hexagone: "Hexagone",
    nuage: "Nuage",
    goutte: "Goutte",
  },
  colors: {
    encre: "Encre",
    creme: "Crème",
    brun: "Brun",
    rouge: "Rouge",
    orange: "Orange",
    ambre: "Ambre",
    vert: "Vert",
    turquoise: "Turquoise",
    bleu: "Bleu",
    violet: "Violet",
    rose: "Rose",
    gris: "Gris",
  },
  expressions: {
    neutre: "Neutre",
    attentif: "Attentif",
    surpris: "Surpris",
    excite: "Excité",
    heureux: "Heureux",
    hilare: "Hilare",
    colere: "Colère",
    triste: "Triste",
    effraye: "Effrayé",
    mefiant: "Méfiant",
    confus: "Confus",
    curieux: "Curieux",
    fier: "Fier",
    timide: "Timide",
    blase: "Blasé",
    somnolent: "Somnolent",
  },
} as const;

export const format = {
  yesterday: "Hier",
} as const;
