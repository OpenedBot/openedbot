# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce journal couvre l'application openedbot (console, API, worker). Le
connecteur hôte et le protocole tiennent le leur :
[`edge-setup/CHANGELOG.md`](edge-setup/CHANGELOG.md) et
[`protocol/CHANGELOG.md`](protocol/CHANGELOG.md).

## Non publié

### Ajouté

- Réglages › Archives : chaque section (corbeille, bots archivés,
  conversations masquées) s'affiche par pages de 15. Une case par ligne,
  une case pour cocher la page entière et « Tout sélectionner » pour toute
  la section. La sélection se restaure, s'affiche ou se supprime
  définitivement d'un coup. La suppression demande toujours confirmation,
  et un élément en échec reste sélectionné pour réessayer.

### Modifié

- Plus aucun nom technique hérité de l'ancien nom du produit : base et rôles
  PostgreSQL, fonctions SQL, en-têtes, cookies, schéma d'URL de l'app de
  bureau (`openedbot://`), popup natif (`OpenedbotPopup.app`), classes CSS,
  métriques, chemins et fichiers s'appellent tous openedbot. Chacun est
  déconnecté une fois (cookies renommés) et les préférences locales de la
  console repartent de zéro. Une machine déjà liée doit être liée à nouveau
  avec le connecteur mis à jour : le lien a changé de format.
- Les notifications s'affichent en bas à droite partout, réglages compris.
- Réglages › Politiques : « Mentions légales », « Politique de
  confidentialité » et « Conditions d'utilisation » s'ouvrent sur le web,
  dans le navigateur (celui du système depuis l'app de bureau), et non plus
  dans l'application.
- Mon compte : plus d'avatar à initiales devant le nom affiché ni devant
  les membres.
- **Nouveau logo : le bloub.** La mascotte openedbot passe au bloub, en
  vectoriel : favicon (clair ou sombre selon le navigateur), logo de l'app et
  de la connexion, icône de l'app de bureau sur macOS, Linux et Windows,
  icône de la barre des tâches Windows, en-tête des e-mails et site de
  documentation. Sur le bureau, le bloub est posé sur une tuile blanche pour
  rester visible sur un Dock ou un lanceur sombre. L'ancienne mascotte (le
  chat masqué) est retirée.
- Application de bureau macOS (1.0.3) : les versions publiées sont signées avec un
  Developer ID et notarisées par Apple. Le dmg téléchargé s'ouvre sans
  alerte, sans passer par « Ouvrir quand même » dans Réglages › Confidentialité
  et sécurité. Les builds des pull requests restent signés ad hoc.

### Corrigé

- Réglages › Activité : sans aucun bot, le tableau propose « Créer un bot ».
  L'ancien message renvoyait vers la barre latérale, absente de cet écran.
- Le panneau latéral (Réflexions, pièce jointe, contexte) s'ouvre de
  nouveau en glissant depuis le bord : il ne saute plus d'un coup à 320 px
  en décalant le fil.
- **Chargement d'une conversation au rechargement.** La silhouette affichée
  avant les données reprend la forme du fil : bulles de questions et de
  réponses avec leur rangée d'actions, composer à sa taille réelle, titre
  centré dans la barre du haut, quotas GPT, Anthropic et Grok à leur place
  dans le rail, bloub dans la barre de titre du bureau. Le passage à la
  conversation chargée ne fait plus sauter l'écran.
- Réglages › Archives : les boutons des lignes reprennent ceux des autres
  réglages, comme dans Runtime. « Restaurer » et « Afficher » sont des
  pilules neutres, « Supprimer définitivement » une pilule rouge pleine.
- La page introuvable (404) et l'écran de changement de mot de passe
  affichent désormais « openedbot » à côté du logo.

### Retiré

- Les anciens noms d'en-têtes de requête et de relais ne sont plus lus.
- Mon compte : la carte « Session » et son bouton « Se déconnecter » ; la
  déconnexion reste en bas de la barre latérale des réglages.
- Réglages › Connecteurs : le catalogue ne propose plus que Notion, Linear
  et Cloudflare. Netlify, Todoist, PayPal, Attio, Calendly, Webflow,
  Supabase, Sentry et GitLab en sont retirés. Un de ces serveurs déjà
  connecté sur un hôte n'est pas touché : il apparaît comme un serveur
  ajouté à la main.
- Derniers restes de l'ancienne PWA dans la console : le titre Apple de
  l'écran d'accueil, la directive `manifest-src` de la CSP et les textes
  d'installation et de notifications push qui n'étaient plus affichés. Le service
  worker de retrait (`/sw.js`) reste en place pour désinscrire les anciennes
  installations.
- Le filet de sécurité des anciens noms de variables d'environnement
  (d'avant le préfixe `OPENEDBOT_`) : l'API, le worker, la passerelle de
  lien, l'app de bureau, le Makefile et les scripts ne refusent plus de
  démarrer quand l'un d'eux est posé, et `make env-prune` ne les réécrit
  plus sous leur nouveau nom. Un ancien nom est simplement ignoré.

## 1.0.2 — 2026-11-04

### Corrigé

- **Quotas du rail au rechargement.** Les logos GPT, Anthropic et Grok
  tiennent leur place dès l'ouverture, estompés, le temps de la première
  lecture, puis leurs anneaux se remplissent sur place. Ils n'apparaissent
  plus d'un coup une à deux secondes après le reste du rail.

## 1.0.1 — 2026-11-04

### Ajouté

- **Panneau Réflexions.** Un clic sur « Réflexion : Ns » au-dessus d'une
  réponse ouvre le journal du tour dans le panneau de droite : ce que le bot a
  dit entre ses étapes, ses recherches web avec les pages trouvées, ses outils
  et, dépliée, l'erreur d'un outil en échec.
- **Planifier d'abord.** Le menu « + » du composer propose de demander un plan
  avant d'agir, pour les messages de cette conversation seulement. Le bot
  propose un plan sans rien modifier ; « Lancer » l'exécute ensuite avec ses
  règles habituelles. Ses autres conversations et ses routines ne changent pas.
- Un indicateur dans l'en-tête d'une conversation signale un bot en Mode plan
  ou en Accès complet, y compris quand l'organisation en réduit l'effet. Un
  clic ouvre ses règles d'approbation.
- Réglages › Apparence › Accent : dans la conversation d'un bot, les boutons
  et le focus prennent la couleur du bot, ou gardent l'accent de l'application.
- Le menu du compte affiche le quota fournisseur le plus entamé.
- Les résultats de recherche disent qui a écrit, à qui, et quand.

### Modifié

- Le fil et le composer d'une conversation reprennent ceux de grok.com, en
  clair comme en sombre : pendant le run, les étapes défilent sous
  « Réflexion • Ns » (messages du bot, recherches, outils) ; la réponse
  arrive mot à mot dans une bulle, la rangée d'actions dessous.
- Couleurs des bulles reprises de Grok Bot : la bulle de l'utilisateur prend
  la couleur du bot de la conversation.
- L'en-tête « Réflexion » d'un tour tient sur une ligne et ne montre plus
  qu'un compte d'échecs, jamais la sortie brute d'un outil.
- Le code en ligne d'une réponse reste lisible en thème sombre.
- Envoyer un message ne fait plus sauter le fil.
- Application de bureau Linux : la fenêtre et le lanceur affichent l'icône
  d'openedbot.
- La barre latérale suit les quotas GPT, Anthropic et Grok (abonnement
  SuperGrok / Premium+ compris, marqué Grok) à la place du menu du compte ;
  un clic ouvre le relevé complet.
- Le mode de permission d'un bot se règle dans sa fiche (Règles
  d'approbation) et plus depuis le composer : c'est une règle du bot, valable
  pour toutes ses conversations et ses routines.
- Nouveau thème des conversations, en clair comme en sombre :
  - bulles, groupement des messages, blocs de code avec bouton de copie et
    couleurs de syntaxe revues ;
  - largeur de lecture alignée avec le composer ;
  - animations d'arrivée des messages et d'ouverture du composer.
- Les actions d'un message (copier, citer, réagir…) passent dans un menu
  contextuel : clic droit, ou appui long sur téléphone.
- Barre latérale : lignes de conversation plus grandes, en-têtes de section
  revus.
- Taille de texte par défaut : 14 px.
- Sans choix explicite, le modèle proposé d'office est celui de la gamme
  courante d'une famille (Sonnet, Luna, Flash), jamais son haut de gamme.

### Retiré

- Le bouton micro du composer et la fenêtre vocale qu'il ouvrait (dictée et
  appel). La lecture à voix haute des réponses reste.
- Le compte agence de démonstration du jeu de données de développement.
