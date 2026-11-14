# PWA design : Inset Grouped

Le nom du pattern : **iOS Inset Grouped** (`UITableView.Style.insetGrouped`).
C’est la feuille Réglages de ChatGPT iOS, pas la liste colorée de Réglages.app.

Toute surface PWA qui présente des rubriques (roue crantée d’un bot, `/settings`)
suit ce document. Le bureau n’en hérite pas : voir la section [Bureau](#bureau).

## Sujet

Un opérateur règle **un bot Hermes** depuis l’iPhone, en standalone. Un seul
job : choisir une rubrique, puis l’éditer. Le visage du bot est le sujet, pas
l’opérateur, pas le SaaS.

## Tokens

| Rôle | Clair | Sombre |
| --- | --- | --- |
| Canvas (`--openedbot-grouped-canvas`) | `#F2F2F7` | `#000000` |
| Carte (`--openedbot-grouped-card`) | `#FFFFFF` | `#1C1C1E` |
| Filet inset (`--openedbot-grouped-separator`) | `rgba(60,60,67,0.12)` | `rgba(84,84,88,0.65)` |
| Libellé / icône (`--openedbot-grouped-label`) | `#000000` | `#F5F5F7` |
| Légende / valeur (`--openedbot-grouped-caption`) | `#6D6D72` | `#8E8E93` |
| Chevron (`--openedbot-grouped-chevron`) | `#C7C7CC` | `#636366` |
| Pastille fermer (`--openedbot-grouped-close`) | `rgba(120,120,128,0.16)` | `rgba(120,120,128,0.24)` |
| Pressé (`--openedbot-grouped-press`) | `rgba(0,0,0,0.04)` | `#2C2C2E` |
| Retour (`--openedbot-grouped-back`) | `#007AFF` | `#0A84FF` |

Rayons : carte `20px`, feuille `32px` en haut seulement.
Type : `-apple-system, system-ui` déjà servi par le shell. Corps de ligne
`17/22`, légende de groupe `13/16` sentence case (jamais en capitales).
Icônes : outline Tabler, 22 px, trait 1.5, **monochrome**, pas de tuile teintée.

Variables dans `browser/ui-kit/src/styles/mobile.css`. Primitives dans
`src/components/mobile/inset-grouped.tsx`.

## Layout

```
┌─ feuille 32px ─────────────────┐
│                          (✕)   │
│            [visage]            │
│              Nom               │
│                                │
│  Personnaliser Nom             │
│  ┌─ carte 20px ─────────────┐  │
│  │ ⚙  Général         Nom  ›│  │
│  │    ──────────────────    │  │
│  │ ✎  Apparence            ›│  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

- Feuille ancrée bas, quasi plein écran, canvas vrai noir (sombre).
- Fermer : pastille circulaire en haut à droite, pas un bouton ghost.
- Hero : `BotFace` 88 px centré, crayon en overlay → rubrique Apparence.
- Groupes : légende au-dessus, carte sans bordure (le contraste canvas/carte
  fait le relief). Filets **inset** : ils commencent sous le libellé, pas sous
  l’icône.
- Ligne : icône · libellé · valeur grise optionnelle · chevron. 48 pt min.
- Pile : tap → rubrique poussée (`‹ Retour` + titre centré + ✕). Enregistrer
  (et tout CTA de page) vit dans `MobileActionFooter` : barre iOS `.bottomBar`,
  dernier enfant de la colonne, **pas** `position: fixed`, pas une rangée
  `ACTIONS` dans le scroll. L’index n’a pas de CTA. Pilule 44 pt, libellé
  **centré** (`justify-center` + `text-center`) : `items-center` seul laisse
  « Enregistrer » à gauche une fois le bouton étiré.

## Retour

`‹ Retour` est un contrôle de barre de nav iOS, pas un bouton ghost.

- Chevron + libellé `17/22`, bleu système (`--openedbot-grouped-back` : `#007AFF` /
  `#0A84FF`). Jamais `--primary` (violet console).
- Pas de fond, pas de bord, pas de pastille. Appuyé : opacity `0.55`.
- Cible 44 pt. Primitive : `InsetBackButton` / `insetBackClassName`.

## Toast

Bandeau iOS sous l’island, pas le snackbar bureau (bas-droite, carte bordée).

- Ancré `top-center`, `top: max(0.75rem, var(--openedbot-safe-top))`, inset 16 px.
- Pleine largeur dans l’inset, rayon `20px`, matériau
  `#1C1C1E` / blur + saturate. Texte `#F5F5F7`, caption `#8E8E93`.
- Titre `17/22`, description `15/20`. Pas de filet, pas d’ombre bureau.
- L’API `toast.success` / `.error` ne change pas, seulement le chrome PWA.
- `prefers-reduced-motion` : pas de blur ni d’animation.

## Signature

Le visage vivant du bot en hero. C’est la seule pièce mémorable. Autour :
discipline iOS, zéro décor.

Risque assumé : on refuse les tuiles colorées d’iOS Settings et les filets
pleine largeur. ChatGPT iOS non plus : les icônes sont des traits blancs, les
cartes n’ont pas de stroke.

## Copie

Noms de ce que l’opérateur contrôle, pas de ce que le système construit.

- « Personnaliser {name} », « Intelligence », « Connexions »
- « Enregistrer » / « Enregistrement… » / « {name} enregistré. »
- Une erreur dit quoi a cassé. Un vide invite à agir.

## Do / Don’t

- Do : `env(safe-area-inset-*)`, cibles 44 pt, `openedbot-press`, `prefers-reduced-motion`.
- Do : valeurs à droite quand elles existent (nom, modèle, `@slug`).
- Don’t : tuile d’icône teintée, filet au-dessus du composer, uppercase de groupe.
- Don’t : nav latérale, carte bordée, modal centrée : sur `pointer: coarse`.
- Don’t : inventer un second language visuel pour une autre feuille PWA.
  Étendre ces primitives.

## Lancement

La console est une webapp classique (plus de manifeste, de service worker ni
de splash iOS depuis le 2026-10-27). `index.html` peint seulement l’encre de
fond (`#121212`, ou blanc en thème clair) et `#root` reste visible dès le
premier paint. Le premier écran est celui de la route, sans animation
intermédiaire.

## Bureau

Tout ce qui précède ne s’applique qu’à `useIsMobile()` / `[data-mobile-shell]`.
Le bureau (console et app desktop) suit les règles ci-dessous (décision
opérateur du 2026-11-02).

### Réglages : une page du cadre

Les Réglages remplacent la barre des conversations par leur menu de rubriques
(`SettingsPageSidebar`) et occupent la carte principale. La déconnexion est la
dernière entrée du menu, ancrée en bas (`SettingsSignOut`) ; le rail d’icônes
ne la porte plus, ni les quotas.

Une rubrique qui attend sa donnée montre un squelette **de sa propre
charpente**, jamais des cartes génériques : Connecteurs dessine ses onglets,
sa recherche, « Nouveau connecteur » et des sections de lignes sur deux
colonnes (`ConnectorsDesktopSkeleton`). Entrer dans les Réglages précharge
l’inventaire de l’hôte (`prefetchConnectors`, depuis `SettingsFrame`).

Connecteurs › Compétences suit la liste de skills de l'app de référence
(`connectors-skills.tsx`) : pas de carte autour d’un groupe mais un filet
entre les groupes ; le titre est la catégorie traduite (un slug inconnu est
mis en forme, jamais affiché brut), suivie du nombre. Les lignes n’ont pas de
séparateur et tiennent sur deux colonnes. Chacune porte une tuile `bg-muted`
de 36 px au même glyphe (étincelles) : une skill Hermes n’a pas d’icône, et
une initiale répétée se lit comme du bruit. Le survol pose un fond.

Connecteurs › Outils suit le même modèle (`connectors-tools.tsx`) : deux
groupes, « Actifs » puis « Désactivés », chacun suivi de son nombre. L’emoji
que Hermes met en tête d’un libellé devient la tuile et sort du nom. La
pastille « Prêt » n’est pas répétée sur chaque ligne, car le groupe le dit
déjà : seule « Configuration requise » reste. Une ligne désactivée a son nom
et sa tuile atténués. Une note rappelle que ce sont les toolsets de la racine
de l’hôte.

Chaque ligne d’Outils porte son interrupteur, à droite, quand l’hôte autorise
l’écriture (`toolset_management`, toolset réglable, pas interdit). Pendant
l’écriture, l’interrupteur montre l’état demandé. Si l’hôte relit le contraire
(`applied: false`), un toast d’erreur l’annonce, sans supposer de succès.

Une bascule (racine ici, profil dans « Gérer le bot ») vaut dès le prochain
message, y compris dans une conversation déjà commencée. Hermes fige les
outils d’une session à son premier tour : le fil passe alors à une session
Hermes neuve (`threads.hermes_session_generation`, 0163), et openedbot lui
renvoie l’historique.

### Carte : un plateau et sa carte

Décision opérateur du 2026-11-08 (elle remplace « une seule surface ») : une
carte des Réglages est faite de **deux couches**. Le **plateau**, en creux d’un
cran sous la page, porte le titre et sa phrase ; la **carte**, blanche, posée
dedans avec une marge de 6 px, porte le contenu, ses lignes et son pied. Trois
paliers de surface (page, plateau, carte) gardent la carte lisible en sombre,
là où l’ancien panneau unique `bg-card` se fondait dans la page.

| Rôle | Clair | Sombre |
| --- | --- | --- |
| Fond de page (carte principale) | `#F7F7F7` | `#121212` |
| Plateau (`SETTINGS_SHELL`, et celui des fenêtres) | `bg-surface-sunken` `#EDEDEE`, fond plein, bord `border-border/60`, rayon 20 px | `#171717` |
| Carte (`SETTINGS_INSET`, `bg-card`) | `#FFFFFF`, bord `border-border/60`, rayon 14 px, `shadow-sm` | `#262626` |
| Bande d’en-tête de tableau | `bg-background-secondary-default` | `white/5` sur la carte |

- Titre de carte : 15 px semi-gras (`CARD_TITLE`), phrase 13 px atténuée
  (`CARD_DESCRIPTION`), sur le plateau, `px-3 pt-2.5 pb-3`. L’action du titre
  (bouton, contrôle segmenté, pastille) à droite, sur le plateau aussi.
- Dans la carte : lignes séparées par `divide-y divide-border/60`, `px-4` ; un
  pied (note, actions) sous un filet `border-t`, en bas de la carte.
- **Jamais de cadre dans la carte** : pas de liste, de tableau ni de
  `StatusList` bordés à l’intérieur. Un tableau se pose à plat dans la carte ;
  un tableau sans carte va dans `SettingsTableFrame` (`settings-table-frame.tsx`).
- Primitives : `SettingsCard`, `ListSection` / `ListRow`, `SettingsTableFrame`
  et les constantes `SETTINGS_SHELL`, `SETTINGS_SHELL_HEADER`, `SETTINGS_INSET`,
  `SETTINGS_PANEL` (une surface seule : barre d’outils, carte-ligne)
  (`src/components/settings/primitives.tsx`). Ne pas réécrire ces classes à la
  main. Les sections de Connecteurs (`McpConnectorSection`) suivent le même
  modèle.
- Les fenêtres (`Dialog`, bureau) suivent le même modèle, calqué sur le
  `LayerDialog` de Cloudflare (Kumo, `cloudflare/kumo`) : un plateau opaque
  `bg-surface-sunken` (rayon 20 px, marge 6 px), la carte blanche dedans avec
  le titre (15 px), la description et le corps, puis les actions **sur le
  plateau, sous la carte**, sans filet, à droite, l'action principale en
  dernier. Le téléphone garde sa feuille et ses groupes iOS (plus haut).

```
  page #F7F7F7
  ╭─ plateau (surface-sunken) ────────────────────────────╮
  │  Titre                                     [ action ] │
  │  Phrase qui explique le groupe                        │
  │ ┌─ carte bg-card ────────────────────────────────────┐ │
  │ │  Libellé                            [ commande ]   │ │
  │ │  description                                       │ │
  │ ├────────────────────────────────────────────────────┤ │
  │ │  Libellé                                  valeur   │ │
  │ ├────────────────────────────────────────────────────┤ │
  │ │  pied : note ou actions                            │ │
  │ └────────────────────────────────────────────────────┘ │
  ╰───────────────────────────────────────────────────────╯
```

### Regrouper et aligner

- **Un réglage = une ligne** (`ListRow`) : libellé et phrase à gauche, la
  commande à droite sur la même ligne. Pas une carte par réglage avec la
  commande seule sur une rangée vide.
- **Regrouper** les réglages courts d’un même sujet dans une `ListSection`
  (ex. Apparence : « Interface » = langue, thème, taille du texte ;
  « Couleurs » = accent, accent d’une conversation). Une carte à part
  seulement pour un contrôle large (sélecteur visuel, tableau, graphique).
- Choix exclusif court : **contrôle segmenté** (piste en creux
  `bg-background-secondary-default`, option retenue posée dessus), pas une
  rangée de boutons bordés ni de boutons radio. Primitives dans
  `src/components/settings/segmented.tsx` : `Segmented` (boutons
  `aria-pressed`, appliqué au clic), `SegmentedRadio` (vrais radios masqués,
  pour un formulaire enregistré plus tard) dans `FieldsetRow` (la ligne d'un
  `fieldset` : légende et phrase à gauche, commande à droite).
- Faits en lecture seule (garanties, session) : des `ListRow`, la valeur à
  droite si elle est courte, en phrase sous le libellé si elle est longue.
  Jamais de tuiles en capitales avec icône, ni de sous-liste bordée dans la
  carte. Le lien vers la rubrique liée va en pied de carte (`footer`), collé
  en bas pour s'aligner d'une carte à l'autre.
- Trois cartes courtes : `SettingsCardGrid trio` (trois colonnes dès `@6xl`).
  Ex. Politiques : Approbations sensibles | Administration du runtime |
  Protection des données, puis le formulaire des permissions.
- **Cartes côte à côte** quand elles sont courtes : `SettingsCardGrid`
  (`src/components/settings/settings-card-grid.tsx`), une grille en requête de
  conteneur (`@container`, pas la fenêtre), 1 colonne, 2 dès `@4xl`, 3 dès
  `@[90rem]`, hauteurs alignées par ligne, `gap-6`. Une carte longue (membres,
  tableau) reste hors de la grille, pleine largeur dessous.
  Ex. Mon compte : Profil | Connexion, Espace de travail | Session, puis
  Membres.

### Liste des conversations

Chaque section du roster, « Non assignés » compris, a un en-tête repliable
(chevron atténué, plein au survol, compteur une fois replié). L’ouverture
joue `bui-section-open` (fondu + 4 px, 200 ms, coupé sous
`prefers-reduced-motion`).

### Démarrage d’un bot neuf

Du clic sur « Créer le bot » jusqu’à ce que son profil soit **prêt à 100 %** :
**un seul visage, au centre**, « {nom} arrive… » et les **vraies étapes** de
la préparation (`BotArrivalStage`) : son espace sur le serveur, ses règles
d’approbation, ses outils. Le worker publie l’étape en cours
(`bot_profile_provisions.progress`, 0164), le roster la relit toutes les
0,6 s ; les outils sont nommés dès que le socle les connaît et arrivent un
à un. Les trois étapes sont là dès le clic (les suivantes en retrait) : la
page ne bouge pas. `BotCreatingScreen` puis `ThreadStartStage` rendent le
même composant, sans animation d’entrée, et la conversation ne passe pas
par son squelette tant que le bot se prépare : le changement d’écran ne se
voit pas. Seuls les changements d’état bougent (coche, outils).

Ni fil ni composer pendant ce temps : les montrer puis les laisser bouger
décale la page. L’accueil attend lui aussi le profil (la file du worker le
retient) et tourne donc sur la vraie persona du bot. Profil prêt, le fil
vide entre en fondu (`ThreadArrival`) et le composer monte au même instant
(`ComposerArrival`), sans toast ; puis l’accueil s’écrit en direct dans le
fil, avec les indicateurs habituels d’un tour. La ligne du bot dans la liste
dit « Se prépare… » jusque-là. Elle entre dans la liste en se dépliant
(`bui-row-enter`, 280 ms), déjà sélectionnée dès sa première image : la route
provisoire désigne le vrai bot dès la réponse de l’API
(`useRouteBotParams`), sans attendre la navigation. Tant qu’il se prépare, un
bot ne se supprime pas : « Supprimer » est grisé (menu, fiche) et l’API
refuse (409 `BOT_PROFILE_PREPARING`).

### Composer : réponse

Répondre à un message pose un **onglet derrière la carte du composer**, qui
dépasse par le haut, comme l’avis du runtime : « Réponse à {nom} », dessous
`↩` et l’extrait en une ligne (markdown aplati : ni clôtures, ni titres, ni
liens), croix à droite (et Échap). Fond `bg-background-secondary-default`,
`bg-background-tertiary-default` en sombre, liseré gauche à la couleur du bot
(`--bot-tint`).

### En-tête du fil : modèle et contexte

Au bureau, le modèle du fil est une **pastille-icône** dans la barre du haut :
le logo du fournisseur qui répond (`ProviderIcon`, celui du repli s’il y en
a un, sinon l’étoile), et au survol l’infobulle « modèle · effort ». Un repli
pose un point d’alerte sur l’icône. Le clic ouvre le sélecteur en modale.
L’anneau de contexte (`ThreadContextTab`, variante `status`) est juste à
côté, dans l’en-tête ; au téléphone il reste sous le composer, seule place de
la jauge sur petit écran. La ligne sous le composer ne nomme plus le profil
Hermes : il vit dans le détail du contexte.
