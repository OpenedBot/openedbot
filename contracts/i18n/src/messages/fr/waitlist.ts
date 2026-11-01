/** Chaînes françaises, un fichier par domaine : `messages.fr.ts` les assemble. */

// La page publique `/` (sans session). Le copy ouvert / fermé suit
// `product_features.waitlist` via `GET /api/auth/providers`.
export const waitlist = {
  brand: "openedbot",
  kickerRequired: "Accès sur validation.",
  emailLabel: "Adresse e-mail",
  emailPlaceholder: "vous@exemple.fr",
  ctaConsole: "Ouvrir la console",
  submit: "Laisser mon adresse",
  submitRequired: "Rejoindre la liste",
  submitting: "Inscription…",
  note: "La console s’ouvre maintenant. L’adresse, seulement si vous voulez un mot de notre part.",
  noteConsole: "Adresse facultative\u00a0: elle vous évite de la retaper à la connexion.",
  noteRequired: "Un accusé de réception, puis un seul message à l’ouverture. Rien d’autre.",
  joined: "C’est noté.",
  joinedDetail: "{email} est notée. Vous pouvez ouvrir la console tout de suite.",
  joinedDetailRequired: "{email} recevra un seul message, à l’ouverture.",
  already: "Cette adresse est déjà notée.",
  alreadyDetail: "Vous pouvez ouvrir la console tout de suite.",
  alreadyDetailRequired: "Un seul message partira, à l’ouverture.",
  invalid: "Entrez une adresse e-mail valide, par exemple vous@exemple.fr.",
  disposable: "Les adresses jetables ne sont pas acceptées : utilisez une adresse que vous relevez.",
  unknownDomain: "Ce domaine ne reçoit pas de courrier : vérifiez l’adresse.",
  rateLimited: "Trop d’essais depuis cet accès : patientez une minute.",
  failed: "L’inscription n’a pas abouti : réessayez dans un instant.",
  unreachable: "Le service ne répond pas pour le moment : réessayez dans un instant.",
  retry: "Réessayer",
  signIn: "Déjà un compte ? Se connecter",
  language: "Langue",
  // Où ça tourne : la console et le bot, chacun à sa place.
  where: {
    console: "La console\u00a0: navigateur et téléphone",
    bot: "Le bot\u00a0: sur votre serveur",
  },
  // Sous le pli : la landing, en chapitres. Chaque chapitre pose son titre
  // et son chapô sur la page, puis sa preuve dans une bande de nuit : une
  // capture réelle de la console, jamais une maquette. Même lexique que
  // l'accueil : machine, fournisseur d'IA, connexion sécurisée.
  // Ce que fait le bot au quotidien : le salon en grand, puis ce que les
  // chapitres ne couvrent pas.
  does: {
    title: "Au quotidien",
    lede: "Des bots qui se souviennent, reviennent à l’heure et vous demandent avant d’agir.",
    salon: {
      title: "Plusieurs bots, un salon.",
      body: "Réunissez vos bots dans une même conversation. Celui que vous citez répond, les autres passent leur tour.",
      label: "Exemple de salon à trois bots",
      room: "lancement",
      you: { name: "Vous", text: "@rafale, le point de la semaine. @brume, relis-le avant vendredi." },
      rafale: { name: "Rafale", text: "Le site est prêt, la page des prix attend son texte, le lancement tient au 20." },
      brume: { name: "Brume", text: "Relu. Il manque la date de la démo, je l’ajoute\u00a0?" },
      pass: "Sillage n’est pas cité\u00a0: il passe son tour.",
    },
    provider: {
      title: "Le fournisseur d’IA de votre choix",
      body: "Depuis la console, reliez un compte ou une clé d’API\u00a0: Anthropic, OpenAI, Google Gemini, xAI ou OpenRouter.",
    },
    model: {
      title: "Un modèle par bot",
      body: "Choisissez le modèle de chaque bot dans ses réglages. Si vous en changez plus tard, il garde son caractère et sa mémoire.",
    },
    approval: {
      title: "Il demande avant d’écrire",
      body: "Avant d’écrire sur votre serveur ou de lancer une commande à risque, le bot s’arrête et attend votre accord, dans la conversation. Votre réponse est inscrite au journal.",
    },
    connectors: {
      title: "Branchez vos outils",
      body: "Ajoutez un connecteur du catalogue, ou le vôtre\u00a0: le bot s’en sert pour répondre.",
    },
    voice: {
      title: "Parlez-lui",
      body: "Un appel vocal, seul à seul ou dans un salon\u00a0: il vous répond à voix haute.",
    },
  },
  // La landing (sombre, sans-serif, bento) : son héros, la fenêtre de la
  // console et ses menus.
  open: {
    nav: { features: "Fonctions", how: "Installation", faq: "Questions" },
    meet: "Bonjour, ici",
    name: "openedbot",
    lede: "Un bot qui travaille sur votre serveur, pas sur le nôtre. Il vous demande avant d’agir et garde la trace de chaque décision. Support client, agenda, veille ou serveurs\u00a0: c’est vous qui lui donnez son métier.",
    preview: {
      room: "Lancement",
      roomLast: "Brume\u00a0: Relu. Il manque la date…",
      rafaleRole: "Chef de projet",
      rafaleLast: "Point du lundi\u00a0: le site est prêt…",
      brumeRole: "Relecture",
      brumeLast: "Relu, deux corrections.",
      sillageRole: "Veille",
      sillageLast: "Trois liens ce matin.",
      dayOne: "Vendredi, 17:02",
      noted: "C’est noté\u00a0: tu prépares le lancement du 20 septembre. Chaque vendredi à 17 h, je te ferai un point de la semaine en trois lignes.",
      ask: "Rappelle-moi ce que tu as retenu de moi, en une phrase.",
      recall: "Tu prépares le lancement du 20 septembre et tu veux un point de la semaine chaque vendredi à 17 h.",
      dayTwo: "Lundi, 09:00",
      routine: "Routine",
      briefTitle: "Point du lundi",
      colWork: "Chantier",
      colBot: "Bot",
      colState: "État",
      rowSite: "Site",
      rowSiteState: "Prêt",
      rowPrices: "Page des prix",
      rowPricesState: "Texte à relire",
      rowWatch: "Veille",
      rowWatchState: "Trois liens ce matin",
    },
    approval: {
      ask: "Rafale veut envoyer le point de la semaine à l’équipe.",
      allow: "Autoriser une fois",
      deny: "Refuser",
    },
    // La fenêtre du héros jouée comme une petite application
    // (`landing-demo.tsx`) : tout est écrit d'avance, rien ne part sur le réseau.
    demo: {
      label: "Démo de la console openedbot : choisissez une conversation, puis écrivez au bot. Tout se joue dans la page, rien n’est envoyé.",
      channels: "Conversations",
      replay: "Rejouer la conversation",
      composerLabel: "Votre message",
      send: "Envoyer",
      suggestions: "Questions prêtes",
      sources: "Sources",
      fromYou: "Vous :",
      from: "{name} :",
      allowed: "Autorisé une fois",
      denied: "Refusé",
      // L’heure de la dernière activité, dans la barre des conversations.
      time: {
        room: "10:14",
        rafale: "09:00",
        brume: "14:30",
        sillage: "07:30",
      },
      room: {
        day: "Mercredi, 10:14",
        chipBrume: "@brume, c’est relu ?",
        chipSillage: "@sillage, du nouveau ce matin ?",
      },
      rafale: {
        memory: "Je retiens ce que tu me dis, d’une conversation à l’autre : ton lancement du 20 septembre, ton point du vendredi à 17 h.",
        routine: "Je reviens à l’heure sans qu’on me le demande : le point du lundi à 9 h, celui du vendredi à 17 h.",
        chipMemory: "Qu’as-tu retenu de moi ?",
        chipLaunch: "Où en est le lancement ?",
        generic: "Bonne question pour un vrai bot. Ici je joue une démo : crée ton compte, branche ton serveur, et je te réponds pour de bon.",
      },
      brume: {
        day: "Jeudi, 14:30",
        ask: "Relis la page des prix avant vendredi, s’il te plaît.",
        reviewed: "Relu, deux corrections : il manque la date de la démo, et une coquille traîne dans le titre.",
        approval: "Brume veut modifier la page des prix : ajouter la date de la démo et corriger le titre.",
        allowed: "C’est fait : la date de la démo est en place et le titre est corrigé. Rafale l’aura dans son point.",
        denied: "Entendu, je n’y touche pas. Les deux corrections restent en suggestion dans le texte.",
        review: "Envoie-moi le texte : je signale ce qui manque et je te propose la correction avant de la faire.",
        rule: "Je ne modifie rien sans ton accord : la demande arrive ici, tu autorises une fois ou tu refuses.",
        roomReply: "Relu, deux corrections. Je te les propose dans notre fil avant de toucher à la page.",
        chipReview: "Comment relis-tu un texte ?",
        chipRule: "Tu modifies sans me demander ?",
        generic: "Je relirais volontiers, mais cette démo n’a pas de vrai bot derrière. Crée ton compte et envoie-moi ton premier texte.",
      },
      sillage: {
        day: "Mardi, 07:30",
        ask: "Quoi de neuf ce matin ?",
        found: "Trois liens ce matin, dont un sur ton concurrent direct. Le reste ne touchait pas tes sujets.",
        sourceA: "Un concurrent baisse ses prix de 20 %",
        sourceB: "Lancer un produit en septembre : ce qui marche",
        sourceC: "Le salon des indépendants ouvre ses inscriptions",
        watch: "Je lis tes sources avant ton réveil et je ne garde que ce qui touche tes sujets : trois liens, pas trente.",
        chipSources: "D’où viennent tes liens ?",
        chipWhere: "Où tournes-tu ?",
        generic: "Rien dans mes sources de démo là-dessus. Crée ton compte, donne-moi tes sujets, et je veille pour toi dès demain matin.",
      },
      shared: {
        model: "Je tourne sur le modèle que tu choisis pour moi. Change-le dans mes réglages : mon caractère et ma mémoire restent.",
        server: "Je tourne sur ton serveur. La console ne fait que me parler, depuis ton navigateur ou ton téléphone.",
      },
    },
    menu: {
      open: "Ouvrir le menu",
      close: "Fermer le menu",
      sheet: "Menu du site",
      salonBadge: "Salon",
      salonMeta: "Citez un bot, il répond",
      memoryMeta: "Mémoire",
      routinesMeta: "Routines",
      approvalMeta: "Accord",
      featuresSummary: "Ce qu’un bot fait, carte par carte.",
      featuresAll: "Toutes les fonctions",
      homeMeta: "openedbot n’entre jamais chez vous",
      step: "Étape {n}",
      faqSummary: "Sept réponses courtes, et le Discord pour le reste.",
    },
    more: "Et aussi",
    howLede: "Trois étapes, et votre premier bot répond.",
    rights: "La console dans votre navigateur, le bot sur votre serveur.",
  },
  chaptersLabel: "Chapitres",
  chapters: {
    memory: {
      title: "Il vous connaît.",
      lead: "Vous décrivez qui il est et ce qu’il doit faire. Il retient ce que vous lui dites, d’une conversation à l’autre.",
      alt: "L’app openedbot sur iPhone : Camille dit à Rafale que le nouveau produit d’Acme sort le 20 novembre et que l’équipe se réunit chaque lundi à 9 h ; Rafale l’enregistre en mémoire, puis le confirme.",
      caption: "Rafale retient ce qu’on lui dit, et la ligne memory le montre. Rien n’est mis en scène.",
    },
    routines: {
      title: "Il revient à l’heure.",
      lead: "Un point du lundi, une veille du matin, un rappel : dites-le une fois, il le fait à l’heure.",
      alt: "L’app openedbot sur ordinateur : la routine « Point du lundi » de Rafale a tourné et rend dans le fil un tableau Chantier, Bot, État, puis la prochaine étape.",
      caption: "Le point du lundi arrive tout seul dans le fil, à l’heure dite.",
    },
    machine: {
      label: "Chez vous",
      title: "Tout tourne chez vous.",
      lead: "Le bot vit sur votre serveur. openedbot garde la console et vos réglages, et n’entre jamais sur la machine.",
      alt: "Les réglages de la machine sur un téléphone : votre hôte, une flèche vers openedbot, l’état « runtime prêt », et la connexion sortante ouverte.",
      caption: "Votre machine ouvre elle-même la connexion vers openedbot. Rien à ouvrir chez vous.",
      facts: {
        a: "Votre serveur, loué ou à la maison.",
        b: "La connexion part de chez vous vers openedbot, jamais l’inverse.",
        c: "Aucun port à ouvrir, aucun domaine à acheter.",
      },
    },
  },
  howTitle: "Comment ça marche",
  how: {
    machine: {
      title: "Une machine à vous",
      body: "Un petit serveur loué, ou une machine à la maison, sous Linux.",
    },
    commands: {
      title: "Trois commandes",
      body: "Copiez-les dans votre terminal : elles vérifient la machine, installent le nécessaire et la relient à openedbot.",
    },
    code: {
      title: "Un code à coller",
      body: "La console vous donne un code. La machine se présente, et votre premier bot répond.",
    },
  },
  faqTitle: "Ce qu’on nous demande",
  faqLede: "Les réponses tiennent ici. Si la vôtre n’y est pas, le Discord est ouvert.",
  faqAsk: "Écrire sur Discord",
  faq: {
    code: {
      q: "Dois-je savoir coder ?",
      a: "Non. Vous copiez trois commandes une fois, puis tout se passe dans la console : un caractère, une mémoire, des tâches, une conversation.",
    },
    can: {
      q: "Que peut faire un bot ?",
      a: "Répondre, se souvenir, revenir à heure fixe, et vous demander avant d’agir quand une décision vous appartient. Plusieurs bots peuvent partager un salon.",
    },
    provider: {
      q: "Quel fournisseur d’IA faut-il\u00a0?",
      a: "Celui que vous préférez. Depuis la console, vous reliez un compte ou une clé d’API (Anthropic, OpenAI, Google Gemini, xAI ou OpenRouter, entre autres), puis vous choisissez le modèle de chaque bot.",
    },
    off: {
      q: "Et si mon serveur s’éteint ?",
      a: "Le bot s’arrête avec lui. La console garde vos conversations et vos réglages ; quand la machine revient, il reprend.",
    },
    sees: {
      q: "Qui voit mes conversations ?",
      a: "Vous, dans la console, qui les conserve pour vous les afficher. openedbot n’entre jamais sur votre machine.",
    },
    phone: {
      q: "Ça marche sur téléphone ?",
      a: "Oui. La console est une application web. Le bot, lui, tourne sur votre serveur.",
    },
    port: {
      q: "Faut-il ouvrir un port chez moi ?",
      a: "Non. Votre machine ouvre elle-même la connexion vers openedbot. Rien à ouvrir, aucun domaine à acheter.",
    },
  },
  // Le pied de page, sur le modèle de Multica : la marque et sa phrase, des
  // colonnes de liens, une barre de bas de page, puis le nom en très grand,
  // coupé par le bord. Aucun lien inventé : chaque colonne ne liste que ce
  // qui existe sur ce déploiement.
  // Les sections suivantes : la pastille d'annonce, la carte de
  // présentation, les quatre scènes, les métiers et l'appel final.
  teammates: {
    launch: {
      open: "La console est ouverte",
      required: "Accès sur validation",
      session: "Votre session est ouverte",
      join: "Rejoindre la liste",
    },
    statement: {
      title: "Écrivez à vos bots comme à des coéquipiers",
      body: "Confiez une tâche à un bot comme à un collègue, depuis l’ordinateur ou le téléphone. Il garde le fil, retient votre façon de travailler et revient vers vous quand une décision vous appartient.",
    },
    many: {
      title: "Plusieurs bots, chacun sur son sujet",
      lede: "Créez un bot, confiez-lui une tâche, puis un deuxième pour un autre sujet. Ils tournent sur votre serveur et se répondent dans un salon.",
      memoryUpdated: "Mémoire mise à jour pour",
      routineName: "Point du lundi",
      routineWhen: "Chaque lundi à 09:00",
      routineNext: "Prochain passage dans 2 jours",
      approvalBadge: "Vous gardez la main",
      approvalWorking: "En attente",
      relayAsk: "Rafale demande à Brume",
      relayRead: "Brume relit le point",
      relayPass: "Sillage passe son tour",
    },
    jobs: {
      title: "Donnez un métier à chaque bot",
      lede: "Un nom, un visage, un rôle. Le reste, vous le lui dites en une phrase.",
      cta: "Créer mon premier bot",
      sampleLabel: "Dernier message de {name}",
      roles: {
        aurore: "Agenda",
        corail: "Support client",
        meca: "Serveurs",
      },
      rafale: {
        tagline: "Le point de la semaine, sans le demander.",
        body: "Suit vos chantiers, relance ce qui traîne et vous envoie un point chaque vendredi à 17 h.",
        sample: "Point du vendredi : le site est prêt, la page des prix attend son texte, le lancement tient au 20.",
      },
      brume: {
        tagline: "Une deuxième lecture avant d’envoyer.",
        body: "Relit vos textes, signale ce qui manque et vous propose la correction avant de la faire.",
        sample: "Relu. Il manque la date de la démo, je l’ajoute ?",
      },
      sillage: {
        tagline: "Trois liens chaque matin, pas trente.",
        body: "Lit vos sources avant votre réveil et ne garde que ce qui touche vos sujets.",
        sample: "Trois liens ce matin, dont un sur votre concurrent direct.",
      },
      aurore: {
        tagline: "Vos rendez-vous, rappelés à temps.",
        body: "Prépare votre journée, rappelle ce qui arrive et vous demande avant de déplacer quoi que ce soit.",
        sample: "Votre appel de 14 h a changé de salle. Je préviens l’équipe ?",
      },
      corail: {
        tagline: "Des réponses prêtes à valider.",
        body: "Prépare les réponses aux questions de vos clients et attend votre accord avant d’envoyer.",
        sample: "Quatre réponses prêtes. Une demande de remboursement attend votre avis.",
      },
      meca: {
        tagline: "Un œil sur vos machines.",
        body: "Lit l’état de vos services et vous écrit quand quelque chose mérite votre attention.",
        sample: "Le disque du serveur de sauvegarde est plein à 91 %. Je vous montre quoi effacer ?",
      },
    },
    home: {
      title: "Sur votre serveur, avec votre fournisseur d’IA",
      lede: "Le bot vit chez vous. Vous choisissez le fournisseur d’IA et le modèle de chaque bot.",
    },
    final: {
      title: "Rencontrez votre premier bot",
      body: "Il vit sur votre serveur, vous demande avant d’agir et note chaque décision au journal.",
    },
  },
  footer: {
    tagline: "Vos assistants IA, sur une machine à vous. La console reste chez nous, le bot chez vous.",
    cta: "Ouvrir la console",
    product: "Produit",
    help: "Aide",
    signIn: "Se connecter",
    how: "Comment ça marche",
    faq: "Questions fréquentes",
    discord: "Discord",
    copy: "© 2026 openedbot. Le bot reste chez vous.",
  },
  // Les titres de la landing qui n'ont pas d'équivalent plus haut : la
  // bande des modèles, les captures, la grille
  // des raisons et la bande des bots.
  pw: {
    modelsCaption: "Avec les modèles du fournisseur que vous choisissez",
    visualsTitle: "La console, telle quelle",
    visualsLede: "Des écrans réels, pris sur iPhone et sur ordinateur, avec de vrais bots.",
    salonTitle: "Le même salon, partout",
    salonCaption: "Rafale, Brume et Sillage préparent un lancement ensemble. La conversation suit d’un appareil à l’autre.",
    salonAlt: "L’app openedbot sur ordinateur, en thème sombre : le salon « Lancement », où Rafale, Brume et Sillage relisent une page de prix et se passent la parole.",
    salonPhoneAlt: "Le même salon « Lancement » dans l’app iPhone, en thème sombre.",
    whyTitle: "Pourquoi openedbot\u00a0?",
    castTitle: "Un bot par métier",
    castLede: "Chef de projet, relecture, veille, agenda, support, serveurs\u00a0: chacun son visage, chacun son sujet.",
  },
} as const;
