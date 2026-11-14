# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce journal couvre l'application openedbot (console, API, worker). Le
connecteur hôte et le protocole tiennent le leur :
[`edge-setup/CHANGELOG.md`](edge-setup/CHANGELOG.md) et
[`protocol/CHANGELOG.md`](protocol/CHANGELOG.md).

## Non publié

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
