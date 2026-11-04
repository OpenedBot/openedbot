/** Chaînes françaises, un fichier par domaine : `messages.fr.ts` les assemble. */

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
  /* Les étapes du trajet d'une requête, telles que l'écran les nomme. */
  hopBrowser: "navigateur",
  hopApi: "API",
  hopRuntime: "runtime",
  transmit: "Il n’y a rien à réparer de votre côté. Cette référence désigne la ligne exacte du journal : transmettez-la.",
  /* Un titre et une phrase de trajet par nature de panne. Le titre dit ce qui
     s'est passé, la phrase dit jusqu'où la requête est allée : c'est elle que
     lisent les lecteurs d'écran à la place du schéma. */
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
  /* Les faits qu'un écran ajoute au pied de carte quand il sait de quel runtime il parle. */
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
 * Libellés humains des outils du runtime, par nom technique (`payload.tool`).
 * Table consultée par `toolLabel` (`lib/thread-tools.ts`) : un nom absent se
 * rend en mono nu, jamais deviné.
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
  /** Échéance du client dépassée, sans statut HTTP : une lecture se relance sans risque. */
  readTimeout: "L’API n’a pas répondu à temps. Réessaie dans un instant.",
  /** Une écriture sans réponse a peut-être abouti : ne pas la refaire à l’aveugle. */
  writeTimeout: "L’API n’a pas répondu à temps : l’action a peut-être abouti. Vérifie avant de recommencer.",
  /** Un succès dont le corps n’est pas du JSON (page de proxy, réponse tronquée). */
  invalidResponse: "Réponse illisible de l’API (HTTP {status}) : rien n’a été confirmé.",
} as const;

export const face = {
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
