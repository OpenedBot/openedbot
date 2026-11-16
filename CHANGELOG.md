# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce journal couvre l'application openedbot (console, API, worker). Le
connecteur hôte et le protocole tiennent le leur :
[`edge-setup/CHANGELOG.md`](edge-setup/CHANGELOG.md) et
[`protocol/CHANGELOG.md`](protocol/CHANGELOG.md).

## Non publié

## 0.1.3 - 2026-11-16

### Corrigé

- **Un « re » ne recrée plus une routine.** Mesuré en production le
  2026-11-16 : un bot répondait à « re » par `routine_manage create`, d’après
  une ancienne demande restée dans l’historique. L’API refuse désormais toute
  écriture de routine (créer, modifier, mettre en pause, reprendre,
  supprimer) quand le message qui a lancé le run ne la demande pas : il faut
  un indice de planification ou de gestion de routine (FR ou EN : « routine »,
  « rappelle-moi », « tous les matins », « à 8h », « demain », « supprime »…),
  ou un « oui » court en réponse à une proposition de routine du bot juste
  avant. Le modèle reçoit une erreur qu’il peut lire ; `list` reste libre, et
  un run lancé par une routine garde ce qu’il pouvait faire.
- **Pas de doublon de routine par le bot.** Une création dont le nom existe
  déjà (casse ignorée), ou dont la planification, le fuseau et le prompt sont
  ceux d’une routine existante, est refusée et renvoie au `update` de
  l’existante.
- **Les notes d’outil sortent du message de l’utilisateur.** La clé de run
  de `routine_manage` et de `bot_settings_propose` et le fuseau de
  l’utilisateur ne sont plus collés au texte du tour : ils voyagent dans une
  note « Platform metadata for tools; not a user request » placée en dernier
  dans l’historique, juste avant le message. Les instructions (préfixe en
  cache) ne bougent pas d’un tour à l’autre et `runs.input` ne garde que le
  texte de l’utilisateur.
- **L’historique rejoué est clos avant le message courant.** Une note fixe
  (sans horodatage) dit que les messages précédents sont du contexte, que
  seul le dernier message est une demande et qu’une demande refusée, échouée
  ou traitée est close. Le résumé de compaction s’intitule « Historical
  summary — not pending work » et ne produit plus de tâches ouvertes ni de
  prochaines actions. La règle « Work autonomously » ne vaut que pour le
  dernier message, et une routine supprimée par l’utilisateur n’est pas
  recréée sans nouvelle demande explicite.
- **Un fichier cité en clair dans `/workspace` arrive dans le fil.** Mesuré
  en local le 2026-11-16 : un bot créait `notes.md` puis répondait
  « Le fichier `/workspace/notes.md` contient … » sans ligne `MEDIA:`, et
  rien n’était joint. À la fin du run, le worker lit aussi les chemins
  `/workspace/<chemin>` écrits en clair (en code ou non) et les joint comme
  une livraison `MEDIA:` : le texte reste tel que le modèle l’a écrit. Les
  octets viennent de l’hôte (image ou PDF à la racine), sinon de l’écriture
  du tour dans le transcript (un `.md` est rangé en `text/markdown`, aussi
  `.txt`, `.csv`, `.json`, `.html`). Pas de `..`, de chemin hors
  `/workspace`, de motif, de dossier ni de fichier caché ; un chemin d’un
  bloc de commandes (```bash…) est ignoré ; cinq fichiers au plus, sans
  doublon avec `MEDIA:`. Un fichier introuvable est sauté en silence (log
  `debug`).
- **Une mise à jour de l’hôte renouvelle les sessions Hermes des fils.**
  Mesuré en production le 2026-11-16 : le bot « Testeur » gardait la session
  `…:gen2` ouverte le 2026-11-12, avec le pont `tool_search` qu’edge-setup
  ≥ v1.5.9 a retiré au démarrage de l’opérateur, sans que l’API le sache.
  Quand le connecteur annonce un agent différent de celui déjà enregistré
  (`edge-setup/vX.Y.Z`), l’API marque désormais les capacités de tout le
  runtime dans la même écriture : chaque fil de chaque bot passe à une
  session neuve à son prochain run, une seule fois par mise à jour (un défaut
  de cache par fil). Une reconnexion avec le même agent et la toute première
  déclaration ne changent rien.

## 0.1.2 - 2026-11-16

### Ajouté

- **Cartes riches d’un résultat d’outil, d’abord la météo.** Le contrat
  `RunCard` (`@openedbot/contracts-events`, union discriminée par `kind`)
  voyage dans `tool.result.cards` ; `isRunCard` vérifie chaque champ, borne et
  intervalle, et une carte invalide ou d’un genre inconnu n’est pas affichée.
  La console montre les cartes d’un appel dans le fil, à sa place, alignées à
  gauche des bulles du bot et plafonnées à 37,5 rem (600 px), sans toucher la
  ligne d’état du run ; sous 26 rem de large le bloc des conditions s’empile
  à hauteur fixe, comme son emplacement réservé. La carte météo
  (chunk chargé à la demande, emplacement réservé à sa hauteur) affiche les
  conditions actuelles, une bande horaire avec lever et coucher du soleil,
  les jours avec leur barre de températures, et le crédit du fournisseur ;
  le choix °C / °F est une préférence de l’appareil. Les données réelles
  viendront plus tard ; le laboratoire du fil a un scénario « Météo ».

### Supprimé

- Retrait des anciennes API Mobile Connect, APNs, Web Push PWA et Computer/Box,
  avec leurs contrôles console, transports, tâches worker et configuration.
- Retrait du suivi MVP `/api/activation`, des statistiques `/api/usage/bots`,
  des anciens reçus `/api/routines/receipts`, de la liste `/api/workflows`,
  de la lecture individuelle des jobs d’import et de la liste redondante des
  groupes. Les parcours actifs et les API de récupération restent disponibles.
- Retrait des actions runtime déjà abandonnées (`mode`, `activate`), du second
  montage de `runtimeRoutes()` sous `/api/runtimes` et de l’alias juridique
  `/api/legal/catalog`. Les routeurs pluriels de modèles, fournisseurs,
  permissions, audit et releases restent disponibles.
- Retrait du chargeur legacy vide et des helpers sans consommateurs de
  production. Les contrats et la politique commerciale de billing, ainsi que
  le provisionnement Cloudflare géré et sa réconciliation, quittent le cœur.

### Modifié

- **Contexte par appel au modèle allégé.** L’historique d’un fil rejoué à
  chaque appel passe de 48 000 à 32 000 caractères avant résumé (seuil de
  « Compacter l’historique du salon » : 16 000) : un DM de 147 messages
  renvoyait ~10 000 jetons d’historique, la moitié des ~22 000 jetons d’un
  simple « hello ». La consigne web fait appeler `web_search` directement,
  sans recherche d’outil ni de skill préalable, avec `limit: 3` puis
  `web_extract` à `char_limit: 8000` : la question météo mesurée faisait
  5 appels et 137 780 jetons d’entrée, dont deux appels inutiles.
- Les callbacks HTTP privés utilisent le contrat générique `publicEndpoints`.
  Un plug-in refusé répond explicitement 503 ; une configuration invalide et
  une collision de routes empêchent le démarrage. Le plug-in billing conserve
  son URL de webhook et ses réponses existantes.
- Le plug-in privé `cloud` fournit la publication gérée par un port optionnel.
  Tailscale et la lecture des publications existantes restent dans le cœur ;
  un nettoyage privé indisponible reste enregistré et peut être repris.
- Migration `0192_retire_mobile_push` : arrêt du producteur de l’ancienne
  outbox push, sans effacement des données historiques.
- Console : l’activité d’un run tient en une seule ligne d’état sous ses
  bulles, le même élément de l’envoi à la fin : l’avatar du bot, puis les
  points, puis l’étape en cours (« Recherche : … », « En train d’écrire… »),
  et, une fois le run fini, « Réflexion : Ns » à côté du nom du bot, au-dessus
  de sa réponse, qui ouvre le panneau « Réflexions ». Les phrases du bot,
  narration comme réponse, sont des bulles normales, dans l’ordre. À l’envoi,
  la bulle arrive avec cette ligne et le fil descend une seule fois, en bas.
  À la fin du run, la ligne se replie (hauteur et opacité, 200 ms) puis
  disparaît, et le résumé d’un run avec outils s’ouvre au-dessus de la
  réponse au lieu d’apparaître d’un coup. Un run fini ne garde aucune place
  invisible : une réponse sans outil n’a ni nom ni résumé, seule la gouttière
  de 12 px la sépare du message de l’utilisateur. En développement, la durée
  du run passe sur la rangée d’actions de la réponse, après « … ».

### Corrigé

- **Plus de résumé de l’historique avant chaque tour d’un long fil.** Au-delà
  de 32 000 caractères, la fenêtre récente gardée telle quelle glissait à
  chaque tour et laissait sortir un message que le résumé ne couvrait pas
  encore : chaque run d’un fil long appelait d’abord le résumeur (simulation
  sur 60 tours : 41 résumés sur 41 tours au-dessus du budget) et réécrivait le
  bloc d’historique, que le cache du fournisseur ne couvrait donc plus. Le
  rejeu est désormais le dernier résumé suivi de tous les messages
  postérieurs à sa coupe ; un résumé n’est refait que lorsque ce reste
  dépasse 32 000 caractères, et il garde la moitié du budget (16 000) telle
  quelle : 5 résumés sur ces 60 tours, et un historique identique d’un tour à
  l’autre entre deux résumés. Un message ancien de plus de 8 000 caractères
  est rejoué début et fin autour d’un marqueur, le dernier jamais ; un
  résumeur en échec n’est retenté qu’après 8 000 caractères de plus ou
  10 minutes. Même règle pour les salons : le seuil de « Compacter
  l’historique du salon » passe à 16 000 caractères.
- La page « Accès direct » de la documentation (français et anglais) ne
  présente plus `OPENEDBOT_MANAGED_TUNNEL_URL` comme le réglage du tunnel
  géré : la variable n'est plus lue, le tunnel géré vient du plug-in privé
  `cloud`.
- Console : les actions d’un message envoyé (copier, modifier) ne réservent
  plus 34 px sous la bulle. Elles apparaissent au survol ou au focus clavier,
  à gauche de la bulle, sans couvrir le message suivant ; au toucher, l’appui
  long garde les mêmes gestes. Deux messages envoyés à la suite sont séparés
  de 12 px, et le squelette de chargement suit cette géométrie.
- Console : les réactions sous une réponse de bot affichent toutes celles
  enregistrées. 👍 et 👎 n’y apparaissaient plus (reliquat des boutons
  « utile / inutile » retirés) alors que le sélecteur les montrait cochées.
  Chaque emoji est une bascule indépendante par membre, appliquée tout de
  suite, envoyée dans l’ordre (un double clic ne laisse pas la mauvaise
  ligne) et annulée avec un message en cas d’échec ; cliquer une pastille
  retire ou ajoute sa propre réaction. Le sélecteur s’ouvre sous la barre
  d’actions, sinon à côté du bouton, et ne couvre plus le texte de la
  réponse ; il se parcourt aux flèches et se ferme avec Échap.
- Une rafale de messages n’est plus fondue en un seul texte séparé par une
  ligne vide, où le modèle ne répondait qu’à la dernière ligne : l’entrée du
  tour fusionné (remplacement, repli dans un run en file, rejeu des steers non
  lus) numérote chaque message, mot pour mot, sous un en-tête qui demande de
  répondre à l’ensemble. Un message seul reste inchangé.

## 0.1.1 - 2026-11-14

### Ajouté

- **Plug-ins requis : `OPENEDBOT_REQUIRED_PLUGINS`.** Une liste d'identifiants
  de plug-ins (par exemple `audit,permissions`) que l'API, le worker et la
  passerelle du lien doivent avoir chargés au démarrage. S'il en manque un
  (absent, introuvable, invalide, refusé par le chargeur ou par la garde de
  sécurité des lignes), le processus s'arrête aussitôt, en nommant les
  plug-ins manquants. Vide ou absente : rien n'est exigé, le mode solo reste
  permissif.
- **Inviter son équipe, gratuitement.** Le propriétaire ou un administrateur
  d'un espace invite une personne par e-mail depuis Réglages › Compte, comme
  membre ou administrateur, sans limite de membres sur sa propre instance ;
  les membres partagent les bots et les salons de l'espace. La personne
  invitée ouvre le lien, se connecte (ou crée son compte avec le code reçu
  par e-mail, sans qu'un espace à elle soit créé), puis accepte. Un compte
  garde un seul espace : si l'adresse invitée a déjà le sien ou appartient à
  un autre espace, l'acceptation est refusée et le dit. Retirer un membre
  coupe son accès. La migration `0191` remet l'e-mail d'invitation dans la
  file d'envoi.

### Supprimé

- **Les derniers restes du backoffice quittent le cœur ouvert.** Les
  courriels du backoffice et du guichet de support, le compte de backoffice
  semé en développement (`DEV_STAFF_EMAIL`, `DEV_STAFF_PASSWORD`), les cibles
  `make dev-admin` et `make build-admin`, les limites de débit, le canal de
  journal `staff` et les exceptions de chemin propres au backoffice
  disparaissent ; `/api/staff` n'a plus de réponse dédiée et se comporte
  comme toute adresse inconnue. Une session d'assistance reste en lecture
  seule et cantonnée à son espace ; le champ `impersonation` de
  `/api/auth/me` garde son nom pour les applications déjà installées.
- **Le relecteur automatique et les règles en langage naturel quittent le
  cœur ouvert.** Sans le plug-in `permissions`, aucun modèle ne juge plus une
  demande d'approbation : le mode Auto se comporte comme Demander, un nouveau
  bot démarre en Demander, et une demande restée « en revue » est remise à
  une personne (ou refusée sur une routine « Ne jamais attendre »). La
  barrière « demander avant d'agir » reste entière : politiques d'outil
  (autoriser, demander, bloquer), « Toujours » pour un outil, politique et
  plafond de l'organisation, liste de blocage et journal des décisions. Les
  réglages « Revue imposée » et « Règles de l'organisation » ne s'affichent
  plus sans le plug-in ; leurs valeurs restent enregistrées. Le profil Hermes
  `openedbot-reviewer` n'est plus préparé sur les hôtes.
- **L'archivage externe de l'audit quitte le cœur ouvert.** Le cœur ne
  dépose plus les ancres et les verdicts d'audit dans un bucket R2 verrouillé
  et ne lit plus `AUDIT_WORM_*` : la chaîne de hachage locale (`audit_chain`)
  et sa vérification restent l'ancrage du cœur, en solo comme en production,
  et une production démarre sans aucune variable `AUDIT_WORM_*`. Une archive
  externe vient désormais d'un plug-in (`auditArchive`), lu par l'API et par
  la passerelle du lien ; sans lui, chaque vérification dit `worm: disabled`.

- **Un compte, un espace.** Chaque compte a un seul espace, ouvert par sa
  propre adhésion : l'inscription ne demande plus quel type d'espace créer.
  La section « Mon équipe » disparaît ; les membres et leurs rôles se gèrent
  dans Réglages › Compte. La bulle
  de support et l'éditeur de règles ne font plus partie de la version open
  core. `ADMIN_PUBLIC_URL` n'est plus lu, et les adresses retirées répondent
  404. La base suit : la migration `0190` refuse de s'appliquer tant qu'une
  donnée dépend encore de ce qui part.
- **Le guichet de support quitte le cœur ouvert.** La page Support, le
  bouton « Contacter le support », la bulle d'aide, l'entrée du menu du
  compte et sa pastille de réponses non lues disparaissent de la console, et
  `/api/support` répond 404. `/api/health` ne publie plus `supportDesk`, et
  `API_SUPPORT_POLL_MS`, `WORKER_SUPPORT_EVENTS_RETENTION_DAYS` et
  `WORKER_SUPPORT_RETENTION_DAYS` ne sont plus lus. Les tables `support_*`
  restent en base, sans code qui les lise ni les purge, jusqu'à une migration
  ultérieure qui les supprimera.
- **Les notes internes de maintenance quittent le dépôt.** La recette de
  release, l'audit de sécurité interne d'edge-setup, sa procédure de
  publication, son historique et sa provenance ne sont plus livrés avec le
  code. Pour savoir comment un hôte vérifie une release d'edge-setup, la
  référence est désormais
  [`docs/edge-setup-security.md`](docs/edge-setup-security.md), vers
  laquelle pointent le README et celui d'edge-setup.
- **`scripts/` réduit à l'essentiel.** Le dossier ne garde que ce qu'il faut
  pour installer, lancer, tester et publier le produit. Les outils de
  mainteneur partent dans le dépôt privé de documentation (`tools/scripts/`) :
  le rattrapage ponctuel de la chaîne d'audit (`audit-chain-backfill.ts`), la
  mesure de trafic (`measure-traffic.ts` et `lib/traffic-rates.ts`) et le flux
  de worktrees (`worktree.py`, son test, `docs/worktrees.md` et les cibles
  `make wt-new`, `wt-ls`, `wt-merge`, `wt-rm`, `wt-drop`, `wt-sync`,
  `test-worktrees`, que `make test-unit` ne lance donc plus).
- **Plus de section téléphone dans la documentation.** « Use openedbot on
  your phone » / « Utiliser openedbot sur votre téléphone » et la consigne du
  clavier sur téléphone quittent les pages Compte et Conversation, en anglais
  comme en français, tant qu'il n'existe pas d'application mobile.

### Corrigé

- Le `Makefile` racine n'est plus ignoré par `.gitignore` : un clone neuf ou un dépôt recréé le garde (seul `Makefile.local` reste propre au poste).
- **Documentation edge-setup.** Le rôle de l’outil, les plateformes Linux prises en charge et les règles de sécurité sont clarifiés en anglais et en français. Les options sont regroupées dans une référence de commandes désormais publique.

- **`make setup` tourne sur un poste neuf.** Le Bash 3.2 livré avec macOS
  ne connaît pas `declare -A` : `scripts/setup.sh` lit désormais la carte des
  fichiers d'environnement sans tableau associatif. Et une base que
  `make db-migrate` crée appartient désormais à `openedbot_migrator`, sous
  lequel ses migrations tournent, comme en intégration et en production :
  la fonction de la migration `0184` lit enfin `email_outbox` sur un
  PostgreSQL vierge. Une base existante, créée par le superutilisateur,
  garde son propriétaire et son chemin de migration, et `make db-reset`
  recrée la base avec le propriétaire de celle qu'il remplace.
- **La date d'un rappel unique se lit pareil partout.** « Une fois : 13 nov.
  2026 à 09:30 », dans la demande d'autorisation d'une routine comme dans la
  console : les serveurs Linux écrivaient « 13 nov. 2026, 09:30 », car la
  liaison entre la date et l'heure dépendait des données de langue du
  système. Elle vient désormais des traductions d'openedbot (« à », "at").
- **Un bonjour ne crée plus une routine en double.** Un bot qui programme
  depuis le chat pouvait, sur un simple « hello », relancer la liste de ses
  routines ou recréer à l'identique la routine du message précédent pour
  confirmer ce qu'il avait annoncé. Il ne touche plus à ses routines pour un
  bonjour ou une conversation légère, ne crée que ce que le message en cours
  demande, et consulte la liste en cas de doute. Et une création qui reprend
  une routine existante du même bot (même nom, même horaire, même fuseau,
  active ou en pause) renvoie la routine existante, message inchangé, sans en
  ajouter une seconde ; la création à la main dans « Routines… » ne change pas.
- **Une release ne dépend plus du stockage d'artefacts de GitHub.** Les
  workflows de release d'edge-setup et du desktop ne passent plus leurs
  fichiers d'un job à l'autre par un artefact, dont le quota plein a bloqué
  edge-setup v1.5.8 : le cache du run pour edge-setup, avec vérification des
  signatures dans chaque job qui publie, et une relecture sur R2 contre le
  `SHA256SUMS` déjà vérifié pour le desktop. Les journaux de diagnostic ne
  sont plus envoyés qu'en cas d'échec, sans bloquer, et gardés un jour.

### Changé

- **Les mesures du chemin rapide rejoignent leurs tests.**
  `fast-path-measurements.ts` et son test passent de `scripts/lib/` à
  `tests/e2e/bot/kit/`, à côté du kit e2e qui seul s'en sert ;
  `make test-unit` les joue toujours.
- **Sans le plug-in `permissions`, la console ne propose plus le mode Auto.**
  Le choix du mode d'un bot n'offre que Demander, Mode plan et Accès complet
  (touches 1 à 3), un nouveau bot démarre en Demander, et un bot encore
  enregistré en Auto s'affiche en Demander, ce qu'il fait réellement. La
  console solo ne dit plus jamais « relecteur pas encore prêt ». Avec le
  plug-in, Auto reste proposé ; quand le relecteur n'est pas prêt, la raison
  dit qu'il faut le plug-in pro prêt sur le runtime.
- **Sans relecteur prêt, Auto demande vraiment, y compris sous l'ancien
  moteur.** Un bot enregistré en Auto se comporte exactement comme Demander
  quand aucun relecteur (plug-in `permissions`) n'est prêt pour son espace :
  le worker n'approuve plus seul une écriture comme
  `echo changed > notes.txt` sous l'ancien moteur de permissions, l'hôte
  soumet les écritures (politique `ask_writes`, réappliquée par la
  réconciliation), les consignes du bot et l'outil de routines suivent le
  même mode. Accès complet ne change pas.
- **La politique d'approbation de l'hôte suit le relecteur espace par
  espace.** Avec le plug-in `permissions` installé mais pas prêt pour un
  espace, un bot Auto de cet espace reçoit `ask_writes` sur son profil, à
  l'enregistrement comme à la création du profil, et la réconciliation
  durcit dès le passage suivant un profil resté à `off`. Tant que ce n'est
  pas fait, le run ne démarre pas (« Les permissions de ce bot ne sont pas
  encore actives »). La réconciliation ne fait que durcir : quand le
  relecteur redevient prêt, le profil revient à `off` au prochain
  enregistrement du bot.
- **Le cœur accepte les contributions externes.** Les pull requests sont
  bienvenues partout (cœur, `edge-setup/`, `protocol/`, `docs/`) sur
  `develop`, avec un `Signed-off-by:` par commit (DCO, `git commit -s`,
  contrôlé par le workflow `dco`). Une contribution est reçue sous Apache-2.0
  et le cœur reste distribué sous AGPL-3.0-only, ce qui laisse la licence
  commerciale possible. Nouveaux fichiers à la racine : `NOTICE`,
  `TRADEMARKS.md`, `COMMERCIAL.md`, `OPEN-CORE.md` (ce qui est gratuit pour
  toujours et ce qui est payant) et `CODE_OF_CONDUCT.md`.
- **L'aide de `make` et le guide des worktrees passent en anglais.** Les
  descriptions de `make help` / `make help-all`, leurs sections et
  `docs/worktrees.md` sont en anglais pour les contributeurs ; les cibles et
  leur comportement ne changent pas. `make help` cite `make fake-hermes` au
  premier lancement.
- **La CI tourne sur les pull requests vers `develop`, forks compris.**
  `core-ci` et `edge-setup-ci` se lancent sur toute pull request vers `main`
  ou `develop`. Le contrat des workflows refuse désormais
  `pull_request_target` et toute référence à `secrets.` dans un workflow
  déclenché par `pull_request`.
- **`make dev` ne lance plus l'app desktop.** Il démarre l'API, le worker et
  la console web seulement ; `make desktop` lance l'app desktop seule contre
  cette API, et `DESKTOP=1 make dev` garde l'ancien lancement combiné.
- **Deux versions par produit sur R2.** Le bucket des releases ne garde que
  la dernière version et la précédente : edge-setup élague seul après chaque
  publication, le desktop par `make desktop-tauri-prune` (à blanc par
  défaut), dans l'ordre de publication et jamais une version servie par un
  canal de mise à jour.
- **La réponse s'affiche par pas plus fins.** Le texte d'une réponse en
  cours arrive toutes les 50 ms au lieu de 150 ms : il se déroule par petits
  morceaux plus fréquents plutôt que par à-coups.
- **Après une pause, la première réponse part plus vite.** Au-delà de 45 s
  sans message, le worker relisait le catalogue de modèles sur l'hôte avant
  de répondre. Le choix de modèle déjà résolu est désormais gardé 10 min, et
  relu dès que l'hôte signale un changement de sa configuration.

## 0.1.0 - 2026-11-12

Première version publiée d'openedbot : une console, sur le web et sur le
bureau, pour des agents IA qui tournent sur votre propre machine (un VPS ou
un serveur à la maison). Le cœur est sous licence AGPL-3.0 (`AGPL-3.0-only`).

### Ajouté

- **Guide d'architecture pour les contributeurs.**
  `docs/contributing/architecture.md` décrit les couches du monorepo, les
  frontières d'import (`.dependency-cruiser.cjs`) et chaque garde hors ligne
  (plafond de taille des fichiers, lectures étrangères, écritures de runs,
  fournisseur de paiement, parité i18n, périmètre du site de doc, contrat de
  plug-in), avec la façon de corriger un échec.
- **Fichiers de contribution GitHub.** Formulaires d'issue (bug, idée,
  changement de protocole, demande de connecteur, traduction) sans issue
  vierge et avec les liens vers les avis de sécurité privés et les
  Discussions ; modèle de pull request (sign-off DCO, `make check`, ligne de
  CHANGELOG, captures pour l'interface) ; `CODEOWNERS` ; mises à jour
  Dependabot hebdomadaires groupées (Actions, Bun, Go, Cargo) vers
  `develop`. Les modèles de `edge-setup/.github/` et `protocol/.github/`,
  ignorés par GitHub, sont supprimés.
- **Une infrastructure de développement en une commande.** Sur un poste sans
  conteneur `infra-postgres`, `make setup` lance PostgreSQL 17 (même image
  que la CI) et Mailpit depuis `compose.dev.yml` (conteneurs
  `openedbot-dev-postgres` et `openedbot-dev-mailpit`) et inscrit
  `OPENEDBOT_DEV_INFRA=compose` dans le nouveau `.env.local`. Un poste qui a
  déjà ses propres conteneurs les garde, et un `.env.local` existant n'est
  jamais réécrit. Il suffit de Docker : `make setup`, `make fake-hermes`,
  `make dev`.
- **Des bots comme des coéquipiers.** On leur écrit dans un fil, on les
  mentionne avec `@`, on les réunit dans des salons où ils travaillent
  ensemble. Chaque bot a sa fiche : modèle, posture de permission, outils et
  connecteurs. Une action sensible attend votre accord (« Autoriser » /
  « Refuser »), et « Planifier d'abord » demande un plan avant d'agir.
- **Fils de conversation complets.** Réponses en direct, réactions, réponses
  ciblées, pièces jointes et fichiers livrés par un bot, export d'une
  conversation, rendu du Markdown, du code, des diagrammes Mermaid et des
  images, brouillons conservés.
- **Routines programmées depuis le chat.** « Envoie-moi un point chaque
  vendredi à 17 h » ou « rappelle-moi demain à 9 h » crée la routine, dans
  votre fuseau ; elle se modifie, se met en pause et se supprime depuis la
  console, avec son historique d'exécutions.
- **Connecteurs MCP par bot.** « Connecter » autorise un service (Notion…)
  pour un bot précis ; les jetons restent sur votre hôte, et « Connecté »
  n'est affiché qu'une fois l'accès prouvé.
- **Modèles et quotas.** Un catalogue unique de modèles, un modèle global ou
  propre à chaque bot, le mode rapide quand le modèle l'offre, et l'état des
  quotas des fournisseurs.
- **Votre hôte, raccordé sans port entrant.** `edge-setup` installe le
  runtime Hermes et le connecteur, qui ouvre un seul lien sortant vers le
  cloud ; Réglages › Runtime dit ce qui tourne sur l'hôte, prévient quand une
  mise à jour existe et peut alerter sur Discord.
- **Comptes et espaces de travail.** Inscription ouverte, connexion par code
  à usage unique reçu par e-mail ou par Google, espaces partagés avec rôles,
  e-mails des workflows au choix, fermeture du compte depuis Mon compte.
- **App de bureau native pour macOS (Apple Silicon) et Linux** (deb et
  AppImage, x86_64 et arm64). La console y est embarquée, l'app se met à jour
  seule avec votre accord, et sur Mac l'encoche montre le travail en cours et
  les demandes d'accord. L'app macOS est signée Developer ID et notarisée.
- **Apparence réglable.** Thème clair, sombre ou système, taille du texte
  appliquée dès le premier affichage.

### Sécurité

- La console ne se connecte jamais à votre hôte : seule une liste fermée de
  routes du gateway traverse le lien sortant, décrite par le protocole du
  connecteur ([`protocol/SPEC.md`](protocol/SPEC.md)).
- Un secret interne par usage entre l'API, le worker et le gateway de liens ;
  les mises à jour de l'app de bureau et du connecteur sont signées et
  vérifiées avant installation.
