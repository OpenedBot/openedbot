# 0001 — Refonte : desktop Tauri et architecture du produit

- **Statut :** proposition révisée après deux passes de revue Codex, en attente de validation
- **Date :** 2026-11-06
- **Périmètre :** tout le produit — desktop, console, API, worker, link-gateway, connecteur hôte,
  protocole, et leurs effets sur `openedbot-pro`
- **Source :** quatre audits en lecture seule au commit `7ec962d` (develop), puis une revue Codex
  qui a vérifié les affirmations dans le code (section 10). `O` = observé dans le code,
  `I` = déduit, à confirmer

## 1. Contexte et problème

Le desktop est un shell Electron 44 (`apps/desktop`, 4 400 lignes) qui charge la console web
**distante** (`${consoleUrl}/`, `apps/desktop/src/main/window.ts:208`). La performance perçue est
mauvaise. Constats (O) :

- à chaque lancement, la SPA est téléchargée puis parsée ; rien n'est embarqué, et service
  worker et CacheStorage sont purgés au démarrage (`window.ts:291`) ;
- chunk d'entrée de la console : 1,39 Mo minifié, 411 ko gzip, 384 assets ;
- `ConversationScreen` (composer, timeline, react-markdown, KaTeX) et `SupportPanel` sont importés
  statiquement depuis `route-tree.tsx` ; le barrel de `browser/ui-kit` réexporte tout ;
- pendant un streaming, chaque frame redécoupe la réponse et peut re-rendre la timeline entière
  (1 590 lignes, un seul `memo`, pas de virtualisation) ;
- coût fixe d'Electron : trois processus et un Chromium embarqué.

Les audits ont aussi relevé des dettes de structure côté serveur, sans lien avec le desktop, que
l'utilisateur veut traiter dans le même chantier (sections 4.5 à 4.7).

## 2. Décisions déjà prises (2026-11-06)

| Sujet | Décision |
|---|---|
| Shell desktop | Electron → **Tauri 2** (Rust), WebView du système |
| Console dans le desktop | **Embarquée** dans l'app, servie par le protocole local de Tauri |
| Plateformes | **macOS d'abord**, puis Windows (WebView2), puis Linux (WebKitGTK) |
| Revue | Codex relit ce document, puis `codex review --base develop` sur chaque branche d'étape |
| Périmètre | Tout le produit |

## 3. Objectifs et non-objectifs

### Objectifs mesurables

Cibles fixées après la mesure de référence D0 (section 3.1, après les non-objectifs). La colonne « Electron aujourd'hui »
reprend la médiane mesurée.

| # | Objectif | Electron aujourd'hui (D0) | Cible |
|---|---|---|---|
| G1 | Temps du lancement à la liste des fils utilisable, dans trois cas : premier lancement, lancement suivant, premier lancement après mise à jour (le cache de requêtes est invalidé à chaque build, `query-persister.ts:23`) | suivant 452 ms (573 ms en réseau simulé) ; premier 564 ms (1 399 ms en réseau simulé) ; après mise à jour 482 ms (987 ms en réseau simulé) | **≤ 450 ms** au lancement suivant et **≤ 600 ms** au premier lancement comme après une mise à jour, **quel que soit le réseau** |
| G2 | JS chargé par la console | entrée 398 ko gzip ; 859 ko gzip de JS sur 54 fichiers avant la liste des fils | entrée **≤ 200 ko gzip** ; JS chargé avant la liste des fils **≤ 400 ko gzip** |
| G3 | Mémoire au repos, tous processus de l'app, 30 s après l'ouverture d'un fil | 660 Mo (4 processus) | **≤ 330 Mo** (−50 %) |
| G4 | Streaming d'une réponse longue (~9 000 caractères, environ 2 000 tokens) | 0 frame longue pendant le streaming à la remesure (une première série en comptait 2 et 9, sur une fenêtre plus large) ; fps moyen 120, p5 98 à 100 sur un écran à 120 Hz | **aucune frame longue > 50 ms**, avant comme pendant le streaming ; fps p5 ≥ 90 % de la fréquence de l'écran (82 à 83 % aujourd'hui) |
| G5 | Une seule source de vérité par concept : écritures de création d'un tour, transitions d'un run, contrat du pont natif, contrat du connecteur | vérifiée par un garde en CI |

### Non-objectifs

- **Pas de cœur local.** Le desktop reste un client de l'API cloud : pas de base locale, pas
  d'API embarquée, pas de mode hors ligne au-delà du cache de requêtes existant. Les hypothèses
  « cloud only » relevées par l'audit (RLS Postgres, GUC, rôles) restent valides.
- Pas de réécriture de la console dans un autre framework : React 19 reste, on l'allège.
- Pas de changement du connecteur Go ni de Hermes au-delà des sections 4.7 (clé d'appareil,
  corrélation, contrat unique).
- Pas d'application mobile dans ce chantier.

### 3.1 Mesure de référence (D0, 2026-11-06)

Outil : `apps/console/scripts/perf/d0-baseline.ts` (rejouable, écrit `tmp/perf/d0-<date>.json`).
Résultats bruts, non versionnés : G2 et G3 dans `tmp/perf/d0-2026-11-06T09-11-49-579Z.json` ;
G1 dans `tmp/perf/d0-2026-11-06T09-32-03-846Z.json` et G4 dans
`tmp/perf/d0-2026-11-06T10-06-38-327Z.json`, remesurés après les revues Codex de l'outil (voir
« Corrections de l'outil » plus bas).

**Conditions.**
- Machine : Apple M5 Pro, 48 Go, macOS 26.6.2, écran à 120 Hz.
- Logiciels : Electron 44.7.0 (shell compilé, `electron-vite build`) ; Chromium de Playwright 1.64
  en mode headless.
- Console : build de production solo du commit `fe6574f`, servie par un serveur statique qui
  imite la prod (gzip, ETag, `Cache-Control: no-cache` sur le document, comme
  `openedbot-pro/infra/shuttle/web-gate.js` ; les assets hachés, `immutable` en prod, gardent ici
  la fraîcheur heuristique du navigateur, ce qui ne peut que ralentir la mesure) ; `/api` relayé vers
  l'API de dev locale, runtime de la VM de lab 240.
- Essais : 5 par cas de G1 (médiane ci-dessous), 3 pour G3, 2 pour G4. Aucun échec. Aucun essai
  rejeté pour mauvais build : chaque essai vérifie le chunk d'entrée réellement chargé.
- **Marqueur de G1** : le premier lien de la barre latérale vers le fil d'un bot
  (`a[href*="/bot/"]`) est présent et visible. Temps mesuré du lancement du processus (navigateur
  ou Electron) jusqu'au marqueur.
- **Les trois cas de G1** :
  - *premier lancement* : session présente, mais aucun cache HTTP, aucun IndexedDB ni
    localStorage (côté Electron, on garde seulement le fichier de jetons) ;
  - *lancement suivant* : même profil, relancé ;
  - *après mise à jour* : même profil et même origine, après un **second build** dont le build id
    et le chunk d'entrée diffèrent.
- **Réseau** : « local » n'a aucune latence ; le « réseau simulé » ajoute 50 ms d'aller-retour
  par réponse et 50 Mbit/s pour les fichiers. Le serveur parle HTTP/1.1 (6 connexions), là où la
  prod passe par HTTP/2 : la simulation pénalise un peu trop les nombreux petits chunks.

| Indicateur | Web (Chromium headless) | Electron 44 |
|---|---|---|
| G1 premier lancement, local / réseau simulé | 538 / 1 174 ms | 564 / 1 399 ms |
| G1 lancement suivant, local / réseau simulé | 445 / 589 ms | 452 / 573 ms |
| G1 après mise à jour, local / réseau simulé | 455 / 1 083 ms | 482 / 987 ms |
| G1 côté page seulement (depuis la navigation), local : premier / suivant / mise à jour | 244 / 170 / 172 ms | non mesuré (*) |
| G2 chunk d'entrée | 1 356 ko brut, 398 ko gzip | même build |
| G2 avant la liste des fils | JS : 54 fichiers, 2 855 ko brut, 859 ko gzip, 713 ko brotli ; CSS : 2 fichiers, 69 ko gzip | même build |
| G3 mémoire au repos | 1 135 Mo (***) | **660 Mo**, 4 processus |
| G4 délai avant le premier texte | 9,6 et 12,8 s (modèle et hôte compris) | 9,2 et 9,6 s |
| G4 frames longues (> 50 ms) avant le premier texte (envoi, « réflexion ») | 0 | 0 |
| G4 frames longues (> 50 ms) pendant le streaming | 0 | 0 |
| G4 fps moyen / p5, pendant le streaming | 60 / 59,5 à 59,9 (headless plafonné à 60) | 120 / 98 à 100 |

(*) Electron charge la console avant qu'une sonde puisse s'attacher : seul le temps total est mesuré.
(***) Chromium headless sans vraie composition GPU, à titre indicatif seulement ; non comparable à
Electron.

**Ce que ça dit.**
- Sur cette machine, le lancement d'Electron n'est **pas** lent quand le réseau est rapide :
  452 ms au lancement suivant. Le coût vient du réseau. Avec 50 ms d'aller-retour, un premier
  lancement monte à 1,4 s, dont environ 850 ms de téléchargement des 54 fichiers de la console,
  et le premier lancement après une mise à jour à environ 1 s. C'est exactement ce que la
  console embarquée supprime.
- La console télécharge plus du double de son chunk d'entrée avant d'afficher la liste : 859 ko
  gzip. L'écran d'accueil (`overview`) entraîne avec lui les échelles d3 de recharts, le
  markdown du support et KaTeX (liste complète dans le JSON).
- La mémoire (660 Mo) est le vrai écart mesuré. Le streaming est fluide sur cette machine, mais
  les fps p5 restent à 82–83 % de la fréquence de l'écran, et une première série a compté des frames
  longues : à revérifier sur une machine modeste.
- **Cache du document en prod (vérifié le 2026-11-06) :** la prod sert `index.html` en
  `Cache-Control: no-cache` (`web-gate.js`, `cacheControlFor` ; en-tête relu sur
  `https://openedbot.app/`). Le `web.Caddyfile`, sans `Cache-Control`, ne sert plus que l'ancien
  stack du lab : le défaut de fraîcheur qui faussait la première mesure n'existe pas en prod.

**Non mesuré dans D0.**
- La vraie prod sur Internet (latence, TLS, Cloudflare) : uniquement le local et la VM 240.
- Une machine moins puissante que ce M5 Pro.
- La navigation d'un fil à l'autre, la latence de frappe dans le composer, le défilement d'un
  long fil.
- Le premier lancement avec connexion : il dépend de l'e-mail et n'a pas de sens en temps.
- Chaque réponse de G4 allonge le fil de test d'Atlas (de 12 000 à plus de 100 000 caractères
  affichés au fil des essais, au-delà de la fenêtre de 40 tours de la timeline). Les mesures de G3 et G4 ont donc été faites sur un fil qui grandit.

**Corrections de l'outil (revue Codex de `perf/d0-baseline`).** Les trois défauts relevés touchaient
la validité des chiffres ; G1 et G4 ont été remesurés après correction.
- Le cas « après mise à jour » pouvait mesurer l'ancien build : sans `Cache-Control`, Chromium
  réutilisait le `index.html` du build A. Le serveur de mesure revalide maintenant le document
  (`no-cache`, comme la prod) en gardant le cache des assets, et chaque essai vérifie le chunk d'entrée chargé ;
  un essai sur le mauvais build est rejeté et compté. Effet : en réseau simulé, le cas passe de
  531 à 1 083 ms côté web, et de 562 à 987 ms côté Electron. La dispersion inexpliquée de la
  première série venait de là. La revalidation coûte aussi un aller-retour au lancement suivant
  (+10 à 50 ms en réseau simulé).
- G4 comptait les frames longues depuis l'envoi, mais les fps depuis le premier texte. Les deux
  utilisent maintenant la fenêtre du streaming ; l'activité entre l'envoi et le premier texte est
  rapportée à part.
- G4 suivait le texte de tout le fil, qui peut diminuer au-delà de 40 tours, et datait la
  croissance au moment des sondages de l'API. La sonde suit maintenant la réponse elle-même (le
  nouveau `[data-assistant-response]`) et horodate sa croissance dans la page ; la fenêtre
  s'étend de 250 ms après la dernière croissance pour mesurer le rendu d'une réponse arrivée d'un
  bloc. Les intervalles (frames, frames longues) comptent dès qu'ils chevauchent la fenêtre,
  pour ne pas perdre un blocage qui se termine juste après. Remesure : fps p5 d'Electron de 98 à
  100 (contre 102 à 103), toujours aucune frame longue.
- Les échecs d'initialisation d'Electron arrêtent le processus lancé ; les essais de streaming
  ont leur propre boucle, pour respecter `--stream-runs` ; chaque sondage de l'API est borné par
  l'échéance de l'essai.
- Les contextes de navigateur des boucles mémoire et streaming sont fermés dans un `finally`.

### 3.2 Chargement (D1b, 2026-11-06)

Même machine, même script (`apps/console/scripts/perf/d0-baseline.ts`, 5 essais, médianes),
même compte et même runtime que D0 ; console solo du commit de D1b. G3 et G4 n'étaient pas visés.

| Indicateur | Web avant (D0) | Web après | Electron avant (D0) | Electron après |
|---|---|---|---|---|
| G1 premier lancement, local / réseau simulé | 538 / 1 174 ms | 489 / 863 ms | 564 / 1 399 ms | 537 / 1 141 ms |
| G1 lancement suivant, local / réseau simulé | 445 / 589 ms | 409 / 549 ms | 452 / 573 ms | 426 / 553 ms |
| G1 après mise à jour, local / réseau simulé | 455 / 1 083 ms | 430 / 844 ms | 482 / 987 ms | 438 / 663 ms |
| G2 JS avant la liste des fils | 859 ko gzip, 54 fichiers | **389 ko gzip, 27 fichiers** | même build | même build |
| G3 mémoire au repos | 1 135 Mo (indicatif) | 1 208 Mo (indicatif) | 660 Mo | 707 Mo |

**Ce qui a changé.**
- Chargés à l'ouverture et non plus au lancement : l'écran de conversation (préchargé par le
  loader de sa route, en même temps que le fil), l'écran « bot en création », les trois
  dialogues du bot, les dialogues des menus de la barre latérale, la palette ⌘K (les raccourcis
  restent montés), la carte du guichet de support, le markdown des notes de version du
  connecteur, les graphiques et la table de la Vue d'ensemble. La feuille de style de KaTeX
  était importée par `main.tsx`, ce qui tirait tout le chunk de KaTeX (76 ko) dans le premier
  chargement : elle part avec le rendu markdown du fil.
- `@openedbot/browser-ui-kit` se déclare sans effet de bord (`sideEffects`) : son barrel ne
  tire plus vaul, cmdk et les autres composants dans le premier chargement de qui n'en utilise
  qu'un.
- Les modules du premier chargement venant de `node_modules` et du kit d'interface sont
  regroupés en deux chunks (`boot-vendor`, `boot-ui-kit`, groupes `$initial` de Rolldown). Sans
  ce regroupement, le premier chargement comptait environ 80 fichiers, et le premier lancement
  en réseau simulé passait à 1,5 s (plus lent qu'avant) : HTTP/1.1 ne sert que 6 fichiers à la
  fois. La prod sert en HTTP/2 et la console embarquée n'aura plus de réseau, mais la cascade
  reste à éviter.
- `index.html` précharge le dictionnaire de la langue active (`vite-locale-preload.ts`) :
  `main.tsx` l'attend avant le premier rendu, et il n'était découvert qu'après l'exécution de
  l'entrée.

**Lecture.**
- G2 est atteint. La cible « entrée ≤ 200 ko gzip » ne dit plus grand-chose depuis le
  regroupement : l'entrée fait 74 ko, mais `boot-vendor` (167 ko) est chargé avec elle. Le
  budget suivi en CI (`make bundle-budget`, job « Console bundle budget ») porte donc sur le
  **premier chargement** : tous les scripts de `index.html` et le plus gros dictionnaire,
  369 ko gzip pour un plafond de 380 ko. Le plafond laisse ~20 ko au chunk de la route
  d'arrivée sous les 400 ko de G2. L'entrée garde son plafond de 200 ko.
- G1 « après mise à jour » en réseau simulé passe sous 700 ms dans Electron, sans atteindre les
  600 ms visés ; le premier lancement en réseau simulé reste à 0,9–1,1 s. Ces deux cas
  dépendent du réseau, ce que la console embarquée supprime (D2).
- La mémoire n'a pas baissé (707 Mo contre 660 Mo). L'écart n'est pas expliqué : le fil de test
  d'Atlas grandit à chaque série de G4 (section 3.1) et G3 se mesure fil ouvert. G3 reste
  l'affaire du shell (D2), pas du chargement.
- Non fait, faute de gain mesuré suffisant : une seule librairie d'icônes (Q4) ; `@remixicon/react`
  pèse encore 38 ko (avant gzip) dans le premier chargement.

### 3.3 Streaming (D1c, 2026-11-06)

Même machine, même compte, même bot (Atlas), même runtime (VM 240) et même invite que D0 ; la
réponse fait 8 919 caractères à chaque essai. Consoles : builds de production solo de `develop`
(D1b, « avant ») et de D1c (« après »), servis comme en D0. Résultats bruts, non versionnés :
`tmp/perf/stream-profile-2026-11-06T12-41-34-271Z.json` et `…T12-44-31-029Z.json` (1x),
`…T12-47-36-260Z.json` et `…T12-49-26-185Z.json` (4x).

**Conditions.**
- Outil : `apps/console/scripts/perf/stream-profile.ts --build <build> --headed --cpu none`, qui
  joue l'essai G4 de `d0-baseline.ts` (même sonde, `lib/streaming.ts`) sur un build donné. Le
  Chromium headless de D0 cadence à 60 i/s quel que soit l'écran : la cible « p5 ≥ 90 % de la
  fréquence » n'y était pas mesurable sur le web. Les essais tournent donc dans une vraie fenêtre
  (120 Hz) ; `d0-baseline.ts` reçoit `--headed-stream` pour la même raison.
- La sonde ajoute trois lectures : le fps de la page ouverte au repos pendant 3 s avant l'envoi
  (le plancher de la mesure), la part de frames qui ont sauté un rafraîchissement (plus de 1,5 fois
  la frame médiane) et le détail des frames longues (scripts, mise en page forcée, phase).
- Deux allures : processeur normal (5 essais par build) et ralenti 4 fois par CDP
  (`--throttle 4`, 3 essais par build), à défaut d'une vraie machine modeste. Le M5 Pro ne laisse
  voir à peu près aucun coût à vitesse normale.

**Profil d'abord** (`--cpu stream`, 4x, avant tout changement), puis décompte des rendus React
par composant pendant une réponse (crochet `__REACT_DEVTOOLS_GLOBAL_HOOK__`, script jetable) :
- chaque lot de fragments patché dans le snapshot re-rendait tout l'écran de conversation (54 à 93
  fois par réponse) : en-tête, barre latérale (le roster bouge avec chaque fragment), composer,
  timeline et son modèle, et plusieurs passes O(n) sur les 3 300 événements du fil
  (`latestThreadReadThrough`, `runTimings`, signatures des tours) ;
- le partage structurel de React Query recopiait chaque patch local conteneur par conteneur : l'index
  des clés d'événements et la reconnaissance d'un ajout en queue (`eventsAppendedFrom`) ratait à
  chaque lot, d'où un parcours du fil à chaque patch ;
- le rail des tours relisait la position de chaque tour (`querySelector` + `getBoundingClientRect`)
  à chaque défilement, donc à chaque frame quand le fil épinglé suit la réponse ;
- chaque mot écrit gardait son animation (`animation-fill-mode: both`) : 1 200 animations encore
  actives à la fin d'une réponse, restylées à chaque frame. Une trace Chromium à 4x mettait le style,
  la mise en page, la peinture et la composition loin devant le JavaScript.

**Ce qui a changé.**
- Store du message en cours (`lib/stream/live-run-text.ts`) : tant que la fin du fil est une réponse
  déjà confirmée (plus de `LIVE_NARRATION_MAX` caractères, sans notice, approbation ni balise
  `MEDIA:`), ses fragments ne sont plus patchés dans le snapshot à chaque frame. `useThreadStream`
  les retient et les patche tous, dans l'ordre du flux, au plus tard 1 s après, ou avant tout autre
  événement. Seule la bulle de cette réponse s'abonne au store (`LiveTimelineEntry`), et y lit le
  texte du run au-delà de sa dernière `sequence` dans le snapshot rendu : les fragments de texte
  arrivent sans curseur (diffusés avant leur commit), le curseur ne pouvait pas servir de repère.
  Le store est nourri avant le patch et coupe là où le modèle de la timeline couperait la bulle :
  même rendue avec les props d'un snapshot plus ancien, la bulle n'affiche ni doublon ni recul.
- Les patchs locaux du fil gardent leur identité dans le cache (`asLocalPatch`).
- Découpage en blocs incrémental (`splitMarkdownBlocksFrom`) : seules les coupures dont la première
  ligne du bloc est complète sont réutilisées ; un test compare la découpe incrémentale à la
  découpe complète à chaque caractère de plusieurs réponses.
- Le rail des tours mesure au plus toutes les 100 ms, la dernière demande n'étant jamais perdue.
- Les animations d'apparition des mots et des blocs passent en `backwards` : leur dernière image
  est le style propre de l'élément, aucun pixel ne change, mais elles ne restent plus actives
  (une vingtaine au lieu de 1 200 en fin de réponse).

| Indicateur (web, fenêtre réelle, 120 Hz) | Avant (D1b) | Après (D1c) |
|---|---|---|
| Rendus par réponse : écran de conversation / barre latérale / timeline | 54–93 / 53 / 53 | 17 / 16 / 16 |
| 1x : fps moyen / p5 (plancher au repos) | 119,9 / 99–100 (99–102) | 120 / 98–99 (97–99) |
| 1x : frame la plus longue ; frames sautées | 15–18 ms ; 0,1–0,2 % | 10 ms (18 une fois) ; 0–0,1 % |
| 1x : frames longues (> 50 ms) avant / pendant le streaming | 0 / 0 | 0 / 0 |
| 4x : fps moyen / p5 | 50–57 / 25–30 | 83–87 / 55 |
| 4x : frames longues avant / pendant le streaming | 1–3 / 1 (74–91 ms) | 1–3 / 1 (74–93 ms) |

**Lecture.**
- G4 est atteint sur le web au sens des frames longues : aucune, avant comme pendant le streaming,
  sur 5 essais. La cible de fps ne se lit pas à 120 Hz sur cette machine : le p5 mesure surtout la
  gigue des horodatages de `requestAnimationFrame` (7 à 9 ms entre deux frames), et le plancher au
  repos a varié de 97 à 110 i/s d'une série à l'autre dans la journée. Le p5 du streaming reste à
  ce plancher, avant comme après ; la part de frames sautées, elle, est quasi nulle des deux côtés.
  À vitesse normale, D1c ne change donc rien de visible sur un M5 Pro, sinon la frame la plus
  longue (10 ms au lieu de 15 à 18).
- Le gain se voit au ralenti : à 4x, fps moyen ×1,6 et p5 ×2. Ce n'est pas encore fluide : le
  reparse du dernier bloc par `react-markdown` à chaque frame du lissage, puis le style, la mise
  en page et la peinture de la bulle qui grandit, font l'essentiel du coût restant. Pistes, non
  faites : cadencer le lissage à 60 Hz, un arbre markdown incrémental.
- Les frames longues qui restent à 4x ne sont pas du streaming : l'envoi (le `keydown` puis le
  rendu qui suit la réponse 202) et la fin du run (le rendu du message persisté). Elles valent 15 à
  25 ms à vitesse normale. Elles relèvent de l'envoi et de D1d, pas de ce store.
- Le texte retenu n'est pas encore dans le snapshot : pendant une réponse, la recherche dans le
  fil, le rail des tours, l'aperçu de la barre latérale et le filigrane de lecture suivent avec au
  plus 1 s de retard.
- Non mesuré : Electron (le shell ne change rien à ce code ; la remesure attend D2), une vraie
  machine modeste, les fils au-delà de la fenêtre de 40 tours (D1d), WKWebView.

### 3.4 Longs fils (D1d, 2026-11-06)

Même machine, même compte, même bot (Atlas, sur le runtime de la VM 240). Consoles : builds de
production solo de `develop` (D1c, « avant ») et de D1d (« après »), servis comme en D0. Résultats
bruts, non versionnés : `tmp/perf/long-thread-2026-11-06T13-25-55-399Z.json` (avant),
`…T14-49-24-788Z.json` (après), `tmp/perf/stream-profile-2026-11-06T14-45-58-244Z.json` (G4 après).

**Conditions.**
- Outil : `apps/console/scripts/perf/long-thread.ts --headed --turns 300`. Le vrai fil d'Atlas
  (environ 450 tours) reçoit 300 tours synthétiques plus anciens, servis par pages de 40 comme
  l'API (`lib/long-thread-fixture.ts`) : prose, code, tableaux, titres, et une image sur cinq tours
  servie avec 150 à 400 ms de retard, pour qu'elle change de hauteur après le rendu. Environ
  750 tours une fois tout chargé.
- Phases d'un essai : ouverture du fil ; défilement régulier (40 px par frame) dans ce qui est
  monté, vers le haut puis vers le bas ; « Charger les messages précédents » jusqu'au bout ; même
  défilement dans tout le fil (trois passes de 120 s au plus) ; mémoire (nœuds DOM du fil, tas JS
  après un GC, métriques Chromium). Frames par `requestAnimationFrame`, frames longues par l'API
  Long Animation Frames. Un « saut » est un `scrollTop` qui bouge entre deux frames de plus que le
  pas, ou à rebours : la page bouge sous le lecteur.
- Fenêtre réelle à 120 Hz, processeur normal ; pas d'essai au ralenti pour ce fil.

**Avant.** La console montait les 40 derniers tours (8 au premier rendu, le reste quand le
navigateur était libre), puis 30 de plus à chaque clic et chaque page reçue, sans jamais en
démonter. Les tours hors de l'écran avaient `content-visibility: auto` avec une taille réservée de
120 px. Mesuré :
- le fil grandit sous le lecteur : la hauteur estimée de 120 px est bien en dessous de la vraie
  (une fois tout mesuré, un tour fait 840 px en moyenne), et chaque tour rendu en arrivant à l'écran repousse la
  page. Remonter les 40 tours montés fait 64 sauts, jusqu'à 4 585 px d'un coup ; la hauteur du fil
  passe de 47 000 à 194 000 px pendant qu'on le lit ;
- une fois tout chargé : 47 700 nœuds dans le fil, 40 000 à 64 000 objets de mise en page, 115 Mo
  de tas ; le défilement tombe à 92 i/s de moyenne, 30 au p5, 11 % de frames sautées ;
- presque chaque chargement d'une page coûte une frame longue (50 à 147 ms).

**Ce qui a changé.**
- La timeline est virtualisée par tour (`lib/thread/thread-virtual.ts`, arithmétique pure, et
  `use-thread-virtual-rows.ts`). Une ligne est un tour ; deux espaceurs tiennent la place des tours
  démontés. Est monté ce qui croise l'écran, plus un écran de marge de chaque côté (600 px au
  moins). Épinglé en bas, la plage part de la fin.
- Hauteurs : mesurées (`offsetHeight`, `ResizeObserver`) et gardées quand un tour est démonté ; un
  tour jamais vu est estimé d'après son contenu (lignes, blocs de code, titres, tableaux, images,
  approbations). `content-visibility` est retiré : c'était lui qui faisait sauter la page.
- Ancrage manuel du lecteur quand il n'est pas en bas : avant chaque changement, l'élément le plus
  profond en haut de l'écran est retenu (pas une puce de date, qui peut disparaître) ; après, le
  défilement compense son déplacement. WKWebView n'a pas `overflow-anchor`, et la colonne le coupe
  déjà : l'ancrage ne dépend pas du navigateur. Un tour qui fusionne avec le précédent après un
  chargement (un run d'accueil) est retrouvé par la clé de son entrée.
- Sélection et focus : les tours qui portent les deux bouts d'une sélection, et le tour du focus
  clavier (`:focus-visible` seulement, un clic de souris ne retient rien), restent montés, avec
  tout ce qui est entre eux. La copie sur plusieurs messages marche donc comme avant.
- Aller à un message : un seul événement (`lib/thread/thread-reveal.ts`, sans dépendance, pour ne
  pas grossir le premier chargement) monte le tour de la cible puis la fait défiler. Il sert à
  `focus=`, à la recherche globale (⌘K), à la recherche dans le fil (⌘F) et au rail des tours, qui
  allume les repères des tours démontés d'après leur rang.
- L'animation d'arrivée ne joue que pour un tour nouveau en fin de fil, jamais pour un tour remonté
  par le défilement.
- « Charger les messages précédents » demande directement la page suivante à l'API (40 tours) :
  il n'y a plus de tours retenus en mémoire sans être montés.

**Pourquoi pas `@tanstack/react-virtual`.** Le fil a déjà un découpage en tours, une colonne
`justify-end` épinglée en bas, des pages ajoutées au-dessus, des approbations et une réponse en
direct (D1c) qui grandissent en bas, et des cibles à atteindre par identifiant. La bibliothèque
gère des index et des tailles, pas l'ancrage sur l'élément lu, l'épinglage, la retenue de la
sélection ni la révélation par cible : il aurait fallu écrire ces parties autour d'elle. Le code
maison fait environ 600 lignes, testées sans navigateur, et n'ajoute rien au bundle.

| Indicateur (web, fenêtre réelle, 120 Hz, 1x) | Avant (D1c) | Après (D1d) |
|---|---|---|
| Ouverture : premier rendu / tours montés complets | 399 / 545 ms | 344 / 355 ms |
| Ouverture : frames longues ; nœuds du fil ; tas JS | 2 (99 et 135 ms) ; 5 405 ; 25 Mo | 0 ; 140 ; 17 Mo |
| Défilement dans ce qui est monté : sauts (le plus grand) | 64 (4 585 px) | 0 |
| Défilement dans ce qui est monté : fps moyen / p5 | 120 / 101 | 120 / 100–101 |
| Chargement d'une page : durée ; frames longues | 450–852 ms ; 13 sur 17 clics (50–147 ms) | 455–774 ms ; 0 sur 10 clics |
| Tout chargé (~750 tours) : nœuds du fil ; objets de mise en page | 47 689 ; 40 319 (64 351 après défilement) | 211 ; 1 472 |
| Tout chargé : tas JS après GC ; mémoire des processus Chromium | 112–115 Mo ; 1 417–1 650 Mo | 32–34 Mo ; 1 064–1 211 Mo |
| Tout le fil, 3 passes de 120 s : fps moyen / p5 ; frames sautées | 92 / 30 ; 10,5–10,9 % | 120 / 99–110 ; 0 % |
| Tout le fil : sauts ; frames longues | 0 ; 2 (50 et 57 ms, script) | 1 (256 px) ; 1 (269 ms, ni script ni mise en page) |
| G4, streaming d'une réponse de ~9 000 caractères, 3 essais : fps p5 ; frames longues | 98–99 ; 0 (D1c) | 98–101 ; 0 |

**Lecture.**
- Le fil long est fluide : avec 750 tours chargés, le défilement reste au niveau du fil court
  (120 i/s, p5 à la gigue de `requestAnimationFrame`, aucune frame sautée), là où l'avant
  tombait à 30 au p5. Le DOM ne dépend plus de la longueur du fil : 140 à 211 nœuds dans le fil
  au lieu de 47 700, 34 Mo de tas au lieu de 115. Le streaming (G4) ne régresse pas.
- La page ne saute plus sous le lecteur. Le seul saut restant (256 px, une fois sur trois passes)
  coïncide avec une image de la fixture qui arrive pendant que son tour entre dans la marge ;
  la sonde compte comme saut une compensation égale au pas, d'où des faux positifs possibles. À
  la main, dans le navigateur, aucun saut vu (chargements successifs, images, fil épinglé).
- La hauteur totale grossit encore pendant le premier passage (586 000 → 650 000 px) : les
  estimations d'un tour jamais vu sont environ 10 à 23 % sous la hauteur réelle des tours
  d'Atlas. L'ancrage compense, la lecture ne bouge pas ; seul le pouce de la barre de défilement
  change de taille. Les estimations se règlent dans `thread-virtual.ts`.
- Une frame de 163 à 269 ms par essai pendant le défilement complet, sans script ni mise en page
  (Long Animation Frames n'attribue rien) : cause non établie, probablement hors de la page (GC du
  navigateur ou compositeur). L'avant n'en avait pas de ce type, mais avait deux frames longues de
  script ; à surveiller sur WKWebView.
- Le premier rendu gagne peu (399 → 344 ms) : il ne montait déjà que 8 tours avant de compléter la fenêtre.
- Vérifié à la main, dans un vrai navigateur (Chromium, Playwright, build de production, fil de
  750 tours) : `focus=` vers un message démonté (centré, anneau, repère du rail allumé) ; ⌘K vers
  un message ; ⌘F vers le 150e tour et le résultat suivant ; clic sur le rail ; cinq chargements
  successifs sans que le message lu bouge ; sélection à la souris sur deux tours gardée après un
  aller-retour en bas, copie complète (559 caractères) ; arbre d'accessibilité (`log`, bouton,
  tours dans l'ordre, espaceurs `aria-hidden`) ; 80 Tab traversent 12 tours sans quitter le fil ;
  coque mobile 390×844 ; pièce jointe image ; vraie carte d'approbation reçue en défilant
  3 000 px plus haut (le fil revient en bas, refus fonctionnel) ; une vraie réponse d'Atlas suivie
  en bas, au plus 4 tours montés, 0 frame longue sur 40 s. Pas de styles d'impression dans la
  console : rien à faire régresser.
- Limites connues :
  - une sélection qui va d'un bout à l'autre du fil garde monté tout ce qui est entre ses bouts ;
  - la recherche native du navigateur (⌘F hors de la console, ou dans le desktop sans la barre de
    recherche du fil) ne voit que les tours montés ; la recherche du fil couvre tout ;
  - un bloc d'activité déplié se replie si son tour est démonté puis remonté ;
  - la recherche globale vers un message d'une page pas encore chargée reste limitée comme avant ;
  - non vérifié : VoiceOver, l'inertie du défilement sur iOS, WKWebView et WebKitGTK (D2, D5),
    une vraie machine modeste.


### 4.1 Vue d'ensemble

Le flux reste le même ; ce qui change est marqué `*…*`.

```
 +---------------------------------------------+
 |  *desktop Tauri*  (Rust)                    |
 |                                             |      +------------------------+
 |   +-------------------+   IPC typé          |      |  API  (Hono / Bun)     |
 |   | console embarquée | <---------------->  | ---> |  HTTPS + SSE, bearer   |
 |   | origine locale    |  *pont natif*       |      |  *origines natives*    |
 |   +-------------------+                     |      |  *garde de version*    |
 |                                             |      +-----------+------------+
 |   auth PKCE, coffre, deep link, notch,      |                  |
 |   *mise à jour signée*                      |                  | Postgres
 +---------------------------------------------+                  v
                                                      +------------------------+
                                                      |  worker                |
                                                      |  *seul à exécuter      |
                                                      |   les effets de run*   |
                                                      +-----------+------------+
                                                                  |
                                                                  v
 +----------------------+   WSS sortant   +------------------------+
 |  hôte utilisateur    | --------------> |  link-gateway          |
 |  connecteur Go       |                 |  *corrélation de bout  |
 |  -> Hermes           |                 |   en bout*             |
 +----------------------+                 +------------------------+
```

Conclusion : le desktop ne touche que le client et une petite partie de l'API (origines,
garde de version) ; le reste du serveur avance sur une piste séparée (section 6).

### 4.2 Variantes et distribution (solo / pro)

Les écrans pro sont injectés **au build** de la console (`apps/console/vite-pro-console.ts:5`,
`OPENEDBOT_CONSOLE_PLUGINS`). La console web de production est construite et déployée depuis
`openedbot-pro`. Une console embarquée construite en solo ne recevrait donc pas les écrans pro,
même connectée à une API pro (O, relevé par Codex).

**Décision (2026-11-06, Q8) : le desktop est solo.**

- la console embarquée est construite **sans** plugins console pro ; le pipeline desktop ne
  récupère pas `openedbot-pro` ;
- quand une route ou une action pro est demandée dans le desktop (lien profond, notification,
  lien partagé), la console affiche « Ouvrir dans le navigateur » et ouvre l'URL publique de la
  console web via l'adaptateur de plateforme, au lieu d'un écran vide ou d'une erreur 404. La
  liste des préfixes de routes pro est un contrat vérifié par un test (I : préfixes à inventorier
  dans `pro-console/registry.ts`) ;
- les écrans pro ne vivent que sur le web, servi depuis l'origine de la console : ils ne sont pas
  concernés par le découplage d'origine de la section 4.4 ;
- les budgets de taille (G2) sont mesurés sur la variante solo pour le desktop, et sur la variante
  web de production pour le web.

### 4.3 Desktop Tauri

**Structure.** Nouvelle app `apps/desktop-tauri` (nom définitif à la bascule) :

```
 apps/desktop-tauri/
   src-tauri/                 Rust : commandes, plugins, notch, coffre, diagnostics
   src-tauri/capabilities/    permissions IPC
   src-tauri/permissions/     permissions des commandes maison
   package.json               workspace Bun : build de la console en mode desktop + bindings
 contracts/native-bridge/     types TS générés depuis Rust (tauri-specta), versionnés
```

Electron (`apps/desktop`) reste livré tel quel jusqu'à la bascule (D3).

**Backend configurable.** Aujourd'hui le shell choisit son backend au lancement (variables
d'environnement, `config.json`, `defaults.json`, `config.ts:37-55`) et isole les jetons par origine
d'API (`target.ts:97-101`). On garde cette capacité : l'origine de l'API est une **configuration
runtime validée** (http seulement pour loopback et réseau local, comme aujourd'hui), avec coffre,
cache de requêtes et stockage isolés par backend. Pas d'`API_ORIGIN` figé au build pour le desktop.

**Correspondance des responsabilités** (O, `apps/desktop/src/main/*`) :

| Electron | Tauri 2 (cible) | Note |
|---|---|---|
| Auth PKCE (`auth.ts`) : code e-mail, Google via navigateur + attente du claim, refresh anticipé mono-vol | Commandes Rust (`reqwest`, proxy système) | Refresh mono-vol **partagé** entre console et notch (`auth.ts:265-273`) |
| Déconnexion : attendre la rotation en cours, révoquer, effacer localement même si la révocation échoue (`auth.ts:467-489`, `main.ts:239-247`) | Même séquence en Rust | Une révocation ratée est journalisée, la session locale est quand même effacée |
| Déconnexion : décharger la console, purger IndexedDB par origine, attendre avant de réafficher la connexion (`window.ts:437-471`) | Équivalent : recharger sur une page vide, purger les données de la WebView pour l'origine locale | Ne pas laisser de données d'un compte au compte suivant |
| Coffre `safeStorage` (`token-store.ts`, `vault.ts`) | Crate `keyring` : Keychain / Credential Manager / Secret Service | Linux sans coffre : session en mémoire seulement, jamais de jeton en clair |
| Choix du backend et isolation par origine (`config.ts`, `target.ts`) | Configuration runtime validée (voir ci-dessus) | |
| `openedbot://auth/callback` + boucle locale `127.0.0.1:47813` (`deep-link.ts`) | `tauri-plugin-deep-link` + même repli | URI déjà autorisées par l'API (`api-config.ts:435`) |
| Instance unique (`main.ts:340`) | `tauri-plugin-single-instance` | Le deep link Windows arrive par la 2e instance |
| Dock (macOS) / tray (Win, Linux) (`tray.ts`) | API tray et menu de Tauri | Modes fenêtre / popup / les deux |
| Raccourci global `Cmd/Ctrl+Shift+O` | `tauri-plugin-global-shortcut` | |
| Fenêtre : position mémorisée et ramenée sur un écran branché (`window.ts:121-142`), fermer = cacher, toujours devant, barre de titre masquée, feux tricolores selon le zoom | `tauri-plugin-window-state` + config de fenêtre + contrôle d'écran au démarrage | Position des feux tricolores : à vérifier sur Tauri 2 (I) |
| Navigation : origines autorisées, `window.open` vers le navigateur | Navigation verrouillée sur l'origine locale, `tauri-plugin-opener` avec liste blanche | |
| Permissions : notifications, presse-papiers | `tauri-plugin-notification`, `tauri-plugin-clipboard-manager` | |
| Menu contextuel (`context-menu.ts:74-116`) : orthographe et dictionnaire, annuler/rétablir, couper/copier/coller, **pas de copie sur un champ mot de passe**, copier le lien, copier l'image | Menu natif de la WebView si la parité est vérifiée, sinon menu maison | La protection du mot de passe est un critère de parité |
| Menus macOS (App, Edit, View, « Taille réelle » = zoom du texte) | Menu Tauri | |
| Hôte du popup notch (`popup-host.ts`, protocole stdin/stdout v1) : un lancement puis jusqu'à 5 redémarrages avec délai ; arrêt immédiat si absent ou incompatible (`:141-149`, `:301-309`) ; routes du popup converties vers l'origine de la console (`:224-271`) | Module Rust, même protocole (`serde`), mêmes règles | La conversion des routes vise désormais l'origine locale |
| Diagnostics SQLite masqués (`diagnostics.ts`) : erreurs de la page, réponses HTTP ≥ 400 et erreurs réseau sur les origines suivies, chargements ratés, renderer disparu ou bloqué (`window.ts:160-193`) | `rusqlite` + même rétention ; erreurs de page et réseau relayées par le pont ; plantage de la WebView détecté côté Rust | Ce que WKWebView expose d'un plantage est à vérifier (I) |
| Thème et zoom du texte (canaux cachés du preload) | Commandes du pont typé | Le facteur de zoom vit à **un** endroit (aujourd'hui 4) |
| Repli `signin.html`, sonde du pont, purge du service worker | **Supprimés** | Inutiles avec une console embarquée |
| — | `tauri-plugin-updater` | Nouveau, voir « Mises à jour » |

**Pont natif.** Un seul contrat, défini par les commandes Rust et généré en TypeScript
(`tauri-specta`) dans `contracts/native-bridge`. La console n'y accède que par **un** adaptateur,
`apps/console/src/lib/platform/` (implémentations `web` et `tauri`). Les 18 imports directs de
`native-bridge` disparaissent ; un garde dependency-cruiser interdit d'importer l'implémentation
ailleurs. Le pont annonce sa version ; une méthode absente donne une erreur nommée, pas un plantage.

**Sécurité IPC.** Les capabilities seules ne restreignent pas les commandes maison (relevé par
Codex). Chaque commande est déclarée dans `AppManifest::commands`, reçoit une permission explicite,
et la capability ne l'accorde qu'à la fenêtre principale sur l'origine locale. Des tests vérifient
le refus depuis une autre fenêtre ou une autre origine. Le jeton d'accès reste côté Rust et n'est
remis qu'à la demande (comme `readAccessToken` aujourd'hui).

**Authentification.** Le desktop reste en **bearer** avec `credentials: "omit"`
(`apps/console/src/lib/api/http.ts:350`), y compris pour le SSE et les plugins pro. Les cookies
restent `SameSite=Lax` (`auth.ts:705`) : on ne les assouplit pas pour une origine locale. Les deux
endroits qui forcent `credentials: "include"` (`browser/api-client/src/api-client.ts:193`,
`support-stream.ts:70`) passent par l'adaptateur.

**Signature macOS.** Hardened runtime **sans App Sandbox**, comme aujourd'hui. On ne recopie pas
les exceptions de V8 (`allow-jit`, `allow-unsigned-executable-memory`,
`build/entitlements.mac.plist:13-16`), puisque WebKit tourne hors processus ; à confirmer par le
prototype. Le popup est copié dans `Contents/Helpers` (`bundle.macOS.files`) **avant** la signature
de l'app, l'ensemble est signé de l'intérieur vers l'extérieur, notarisé, agrafé, puis testé
téléchargé sous quarantaine.

**Mises à jour (conséquence de la console embarquée).** Une correction de la console ne parvient
plus aux utilisateurs desktop par un déploiement web.

- `tauri-plugin-updater`, artefact macOS `.app.tar.gz` signé (distinct du dmg), clé de mise à
  jour distincte du Developer ID et gardée hors de l'hébergement ;
- manifeste par canal (bêta, stable), architecture et variante ; artefacts immuables ; promotion
  d'un canal à l'autre seulement après vérification ;
- l'en-tête `X-OpenedBot-Client: desktop/<version>` sur chaque requête, ajouté aux en-têtes
  autorisés du préflight (`apps/api/src/index.ts:305`) ;
- l'API sert les clients jusqu'à N versions en arrière et répond `426` avec un code stable sous
  une version minimale configurable ; le desktop affiche « mise à jour requise » avec un bouton
  de mise à jour et un lien de réinstallation manuelle.

**Session et données locales à la bascule.** Le moteur et l'origine changent : IndexedDB et
localStorage d'Electron ne sont pas repris. Les brouillons texte sont persistants
(`workspace-draft.ts:10-29`) et seraient perdus. Recommandation (Q1) : une reconnexion unique,
perte des brouillons annoncée dans la note de version, et jamais Electron et Tauri connectés en
même temps avec le même refresh token.

### 4.3.1 Prototype D2a (2026-11-06)

Prototype vertical, non distribué : `apps/desktop-tauri/` (workspace Bun `desktop-tauri`, Rust
dans `src-tauri/`, Tauri 2.12.5), contrat `contracts/native-bridge/`, adaptateur
`apps/console/src/lib/platform/tauri-bridge.ts`. Identifiant `app.openedbot.desktop.preview`, nom
« openedbot preview », service Keychain distinct, aucun schéma `openedbot://` : il cohabite avec
l'app Electron. Mesures sur le Mac de dev (macOS 26.6.2, arm64), API locale, runtime de la VM 240.

**Ce qui est prouvé.**

| # | Point | Preuve |
|---|---|---|
| 1 | Console embarquée | Build solo en mode desktop (`VITE_OPENEDBOT_SHELL=tauri`) servi par `tauri://localhost` ; repli `index.html` de Tauri pour les chemins profonds. Le build web n'embarque rien de Tauri (vérifié sur le bundle ; `make bundle-budget` 370,6 / 380 ko) |
| 2 | Auth bearer côté Rust | Code e-mail (`/api/auth/login/code`, `/native/code/verify`, `/native/token`, PKCE) mené par Rust ; jeton dans le Keychain (`keyring`), remis à la page par `read_access_token` seulement ; refresh mono-vol (test : 8 appels concurrents, 1 rotation) ; coffre refusé : session en mémoire, rien sur disque (tests). Commandes déclarées dans `AppManifest::commands` (`build.rs`), accordées à la seule fenêtre `main` sur l'origine locale (`capabilities/main.json`) ; tests de refus : autre fenêtre, autre origine (`https://console.openedbot.app`, `http://localhost:1420`), commandes des plugins. Pont typé tauri-specta, contrat vérifié par `cargo test` |
| 3 | Fils et SSE | Fenêtre compacte (`/compact`, comme Electron) : sélecteur des fils des 5 bots, fil d'Atlas, envoi d'un message, réponse du runtime de la VM 240 affichée au fil de l'eau sur **une** connexion `/api/events` |
| 4 | Popup notch | L'hôte Rust lance `OpenedbotPopup --hosted` (openedbot-notch `origin/main`, `OpenedbotHostedProtocol` 1) : `ready` (1.0.0) → `hello` → `signedIn` → jeton servi ; le popup appelle l'API avec ce bearer ; il s'arrête sur EOF quand l'app quitte. Vérifié en dev puis dans l'app signée (`Contents/Helpers`) |
| 5 | En-tête `Origin` | Mesuré par une sonde devant l'API (`scripts/origin-probe.ts`) : **`tauri://localhost`** sur chaque requête de la page (préflight compris), app de dev comme app notarisée. Le CORS de D1a répond `Access-Control-Allow-Origin: tauri://localhost`, sans `Allow-Credentials`, et aucun cookie ne part. Les requêtes de Rust (connexion) n'envoient pas d'`Origin` |
| 6 | Signature, notarisation, quarantaine | Developer ID, hardened runtime, sans App Sandbox, **aucun entitlement** ; popup re-signé de l'intérieur (runtime + horodatage) avant l'app ; app et dmg notarisés et agrafés. dmg marqué `com.apple.quarantine` : `spctl -a -t open` → `accepted, source=Notarized Developer ID` ; app glissée dans `/Applications` par le Finder : `spctl -a -vv` accepté, dialogue de premier lancement « Apple a effectué une recherche de logiciels malveillants et n'en a détecté aucun » |
| 7 | Vraie mise à jour | `tauri-plugin-updater`, `.app.tar.gz` signé par une clé minisign distincte (`~/.config/openedbot-tauri-updater/`, 0700/0600), manifeste servi par `scripts/update-feed.ts` (Bun, boucle locale). v0.0.1 installée depuis le dmg ; v0.0.2 publiée ; au lancement suivant : téléchargement (18 Mo), signature vérifiée, popup arrêté, bundle remplacé, **redémarrage en 0.0.2**, session Keychain relue sans invite (même Developer ID, même identifiant), app toujours notarisée. Manifeste 0.0.3 signé par une autre clé : « The signature was created with a different key than the one provided », 0.0.2 intacte, popup jamais arrêté |

**Entitlements retenus : aucun.** `allow-jit` et `allow-unsigned-executable-memory` sont inutiles :
WebKit compile dans ses propres processus, et l'app signée en hardened runtime affiche et fait
tourner la console.

**Durées de notarisation** (quatre passes, toutes `Accepted`) : build release + notarisation et
agrafage de l'app 61 à 77 s au total ; dmg 28 à 34 s (`notarytool submit --wait`).

**Constats.**
- **Le flux SSE n'avait pas d'en-tête CORS** : `/api/events` rend une `Response` brute, qui ne
  reçoit pas les en-têtes posés par `context.header` avant elle. Sans effet sur le web et Electron
  (même origine), bloquant pour la console embarquée (« Flux interrompu : reconnexion en cours »,
  reconnexion toutes les 5 s). Corrigé dans `apps/api/src/interfaces/http/cors.ts` (en-têtes reposés
  sur la réponse finale) et testé ; la preuve 3 a tourné contre une réplique de l'API de cette
  branche sur la base locale, l'API de `make dev` n'ayant pas encore le correctif.
- **App Translocation** : une app en quarantaine que l'utilisateur n'a pas déplacée lui-même (copie
  par script du Finder) tourne depuis un montage en lecture seule ; la mise à jour y échouait
  (« Read-only file system »), proprement. Le prototype ne tente plus rien dans ce cas et le
  journalise ; un vrai glisser-déposer du Finder (dmg → `/Applications`) n'est pas translocalisé.
- La console complète (`/`) ne pose pas sa session cloud depuis le pont : seule la fenêtre
  compacte le fait (`primeNativeSession`). Le prototype ouvre donc `/compact`, comme Electron.
- tauri-specta importe `@tauri-apps/api` en dur ; un contrat n'importe que zod. L'export Rust
  redirige ces imports vers `contracts/native-bridge/src/runtime.ts`, que l'adaptateur de la console
  remplit avec `@tauri-apps/api` : la règle `contrat-zod-seul` reste entière.
- La CSP de la console desktop porte un marqueur à la place de l'origine de l'API (réglage
  d'exécution) ; la coque le remplace en servant `index.html` (`csp.rs`), IPC de Tauri autorisé,
  script d'audience retiré du build.
- Un build de dev non signé change de signature à chaque compilation : le Keychain redemande
  l'accès. En dev, `OPENEDBOT_PREVIEW_VAULT=memory`.

**Reproduire.** `make desktop-tauri-check` (cargo test, clippy), `make desktop-tauri-mac
TAURI_VERSION=0.0.2 TAURI_POPUP=…/OpenedbotPopup.app`, `make desktop-tauri-feed`, `make
desktop-tauri-publish TAURI_VERSION=0.0.2` ; l'app installée lit
`~/Library/Application Support/app.openedbot.desktop.preview/config.json`
(`apiOrigin`, `publicConsoleUrl`, `updateUrl`, `popup`).

**Écarts restant pour D2b.**
- Connexion Google (navigateur + boucle locale `127.0.0.1:47813`), déconnexion avec purge des
  données de la WebView (sans elle, un cache de requêtes d'un compte reste visible au suivant :
  observé), refresh anticipé par minuterie, instance unique, deep link.
- Console complète depuis le pont, `shell.platform` (figé à `"windows"` par le contrat actuel),
  silhouette de démarrage (le script inline de `index.html` ne voit pas encore le pont).
- Mise à jour : vérification périodique et pas seulement au lancement, message « déplacez l'app
  dans Applications » en cas de translocation, écran « mise à jour requise » (426), attente de la
  sortie du popup avant le remplacement, manifeste par canal et variante, hébergement (Q2).
- Popup : dialogue de repli et préférences fenêtre / popup / les deux ; diagnostics SQLite ; menus,
  raccourci global, tray, position de fenêtre.
- `cargo test` et `cargo clippy` en CI (aujourd'hui `make desktop-tauri-check` en local), crates
  pour Windows et Linux (`keyring` n'active que le Keychain).

### 4.3.2 Parité D2b (2026-11-06)

Branche `feat/d2b-macos-parity`. Le shell Tauri reprend le tableau de la section 4.3 sur macOS.
L'identifiant reste `app.openedbot.desktop.preview`, la version commitée reste 0.0.1. Les builds
de test sont numérotés 0.0.4 à 0.0.15, non publiés. Le code propre à macOS est derrière
`#[cfg(target_os = "macos")]` ou dans `src/macos/` : menus, Dock, purge WKWebView, plantage
de la WebView, `Reopen`.

Le parcours de bout en bout a tourné sur l'app **signée Developer ID, notarisée et agrafée**,
installée dans `/Applications` (`spctl` : `accepted, source=Notarized Developer ID`). Elle
utilisait l'API locale de la branche (:8792), derrière une sonde Google locale (:8793), et le
runtime de la VM 240. Les captures sont gardées hors du dépôt.

| Responsabilité (4.3) | État | Preuve |
|---|---|---|
| Code e-mail | Fait | App signée : code reçu par Mailpit, connexion, console complète `/`. La session du pont est posée par la console complète, plus seulement par `/compact` |
| Google (navigateur + claim) | Fait, même parcours qu'Electron | Navigateur système, puis retour par la boucle locale `127.0.0.1:47813`, sondage du claim (1,5 s, 5 min au plus, un 4xx est fatal), échange PKCE. Sur l'app signée, avec un claim simulé côté API locale : connecté 80 à 120 ms après le retour du navigateur. 8 tests Rust : accepté, refusé, URL d'autorisation inattendue, port occupé, délai, annulation, retour anticipé, contrôle des URL. **Non vérifié** : la vraie page de consentement Google, faute d'identifiants OAuth en local |
| Refresh anticipé, mono-vol | Fait | Minuterie : rotation avant l'expiration ; après un échec, nouvel essai 30 s plus tard, jamais de boucle. Tests en temps suspendu |
| Déconnexion | Fait | Révocation, puis effacement local même si l'API est injoignable (test). La console est déchargée sur `about:blank` et le magasin WKWebView est vidé avec attente de sa confirmation (`removeDataOfTypes`). Sur l'app signée : 0 fichier IndexedDB, 0 LocalStorage, aucun item Keychain. Le thème et la taille du texte de l'appareil sont reportés. Une purge qui échoue garde la console fermée (dialogue « Réessayer / Quitter »), et une purge interrompue est reprise au lancement suivant. Une seule purge à la fois |
| Backend configurable, stockage isolé | Fait | Le coffre est rangé par origine d'API (D2a). Les données de la WebView d'un autre backend sont purgées avant que la console ne se charge (`dataOrigin`, journal « purged »). La navigation du popup attend la fin de la purge |
| Deep link + repli boucle locale | Fait, repli seul actif | `tauri-plugin-deep-link`, et le repli testé quand le schéma n'est pas enregistré. La preview ne déclare **aucun** schéma, pour cohabiter avec Electron : seule la boucle locale sert |
| Instance unique | Fait | App signée : un second lancement quitte aussitôt, et la première fenêtre passe au premier plan |
| Dock | Fait | Menu : Affichage (Fenêtre / Popup / Fenêtre et popup, « popup introuvable » si absente), Toujours au premier plan, Se déconnecter. Lu sur l'app signée ; « Se déconnecter » et « Toujours au premier plan » joués. Le mode Popup seul masque l'icône du Dock tant que la fenêtre est cachée : non éprouvé à l'écran |
| Raccourci global `Cmd+Shift+O` | Fait | App signée : fenêtre cachée, puis réaffichée au premier plan. Un raccourci déjà pris est journalisé, sans effet sur le démarrage |
| Fenêtre | Fait, sauf les feux | Fermer = cacher : vérifié, l'app et le notch continuent. Réouverture par le Dock (`Reopen`). Barre de titre en surimpression, feux à (16, 16). Position mémorisée : sur l'app signée, la fenêtre a été déplacée à (240, 110, 1150 × 740), l'app quittée par son menu, et la fenêtre est revenue au même endroit au lancement suivant. Une fenêtre sur un écran débranché est ramenée sur un écran branché (5 tests). « Toujours au premier plan » se règle dans le menu du Dock : coché, la fenêtre reste au-dessus des autres apps, et le choix est retenu |
| Navigation verrouillée, ouverture externe | Fait | Seule l'origine locale est chargée. Un lien web part dans le navigateur, le reste est refusé. Liste blanche d'ouverture : l'API, la console publique, et `openedbot.app/download`. Tests Rust |
| Notifications | Fait | Polyfill de `tauri-plugin-notification` (trois permissions). Le clic revient par l'événement typé `NotificationClicked` et lance l'`onclick` de la page, donc ouvre la conversation. Test TS. **Non éprouvé à l'écran** : aucune notification de workflow dans le parcours |
| Presse-papiers | Partiel | Menu Edit (Cmd+C / V / X / A dans les champs). `navigator.clipboard` sous `tauri://localhost` n'est pas éprouvé |
| Menu contextuel | Menu natif | Menu de WKWebView. **Non vérifié** : la copie interdite sur un champ mot de passe |
| Menus macOS | Fait | App, Edit, View (Actual Size = taille du texte, Zoom In / Out, plein écran), Window : lus sur l'app signée, Zoom Out appliqué |
| Hôte du popup notch | Fait | App signée : popup lancé depuis `Contents/Helpers`, `ready`, puis jeton servi. Le notch affiche les bots et les notifications de la session. Tests : 5 redémarrages puis repli sur la fenêtre avec dialogue, fermeture par l'utilisateur, popup tenu à l'arrêt pendant l'installation d'une mise à jour, lancement réservé sous le verrou de l'arrêt |
| Diagnostics SQLite masqués | Fait | `diagnostics.sqlite`, alimenté par les erreurs de page, la console, `fetch` vers l'API (≥ 400 ou réseau), les avertissements du shell et le plantage du processus WebKit (journalisé, puis rechargement). Masquage sans regex : bearer, JWT, longues suites, requêtes d'URL, e-mails. Limite de débit, rétention 14 jours, 20 000 lignes. Tests |
| Thème et zoom à un endroit | Fait | La taille du texte de la console est le seul facteur (`set_zoom` du shell, retenu au lancement). Le shell publie le zoom en vigueur à la page à chaque changement, menu View compris, pour la place des feux. Thème : apparence de la fenêtre |
| `shell.platform` | Fait | `"macos"` | `"windows"` | `"linux"` (contrat typé), `native-titlebar` reconnaît `macos` |
| Mises à jour | Fait | Vérification 3 s après le lancement, puis toutes les 4 h (`OPENEDBOT_UPDATE_CHECK_SECONDS` pour les tests). Sur l'app signée, **en cours de session**, deux fois (0.0.10 → 0.0.11, 0.0.14 → 0.0.15) : téléchargement, signature vérifiée, popup arrêté (sortie attendue) puis tenu, bundle remplacé, feuille « Mise à jour installée » (Redémarrer / Plus tard). Après « Redémarrer » : la nouvelle version tourne, toujours notarisée, la session Keychain est relue et le popup relancé. « Plus tard » arrête les vérifications jusqu'au redémarrage : couvert par un test seulement, le bouton n'a pas été joué. Si l'app est translocalisée, un dialogue « Déplacez openedbot preview dans Applications » s'affiche et rien n'est tenté (test du chemin) |
| État de mise à jour | Fait (contrat) | `UpdateState` : idle, available, downloading (octets reçus et total), ready, error (code : flux, téléchargement, signature refusée, popup non arrêté, installation, translocation), required. Côté pont : `update_state`, `restart_to_update` (seulement si `ready`), `report_update_required` (le 426 de l'API, version minimale validée : l'état passe à `required` et le flux est vérifié aussitôt), et l'événement `UpdateStateChanged`. Côté notch : un message `updateState` à chaque changement de statut, ajouté dans la v1 (un notch qui ne le connaît pas ignore la ligne). Les dialogues du shell restent provisoires : l'interface (pastille) est l'étape suivante. Tests Rust et IPC ; non éprouvé sur l'app signée |
| CI | Fait | Job `desktop-tauri` (macOS) dans `core-ci.yml` : `make desktop-tauri-check` (cargo test, clippy `-D warnings`), requis par `ci-ok` |
| Tests de refus IPC | Fait | Autre fenêtre, autre origine, commandes des plugins non accordées (fenêtre, deep link, dialog, raccourci, `register_listener`, fs). Capability exacte, diagnostic forgé refusé, zoom inconnu refusé, bindings à jour |

**Constats.**
- Les dialogues sans fenêtre parente passent par `CFUserNotificationDisplayAlert` (rfd), une
  alerte système dans un autre processus. L'invite de redémarrage de l'app signée est apparue en
  retard, hors de l'app, et n'était pas visible dans les captures. Tous les dialogues du shell
  sont désormais des feuilles de la fenêtre principale, amenée au premier plan.
- Quitter par le menu de l'app ne gardait pas la position de la fenêtre. Le shell retient
  maintenant la dernière position à chaque déplacement et l'écrit à la sortie.
- Une fois, après « Se déconnecter » depuis le Dock, la capture de la fenêtre inactive est restée
  vide. La page de connexion était chargée, et s'est affichée dès que la fenêtre est passée au
  premier plan. Une seconde tentative s'est affichée normalement.
- `window.url()` de wry panique tant que la WebView n'a pas d'URL. Le shell n'interroge jamais
  l'URL : l'origine locale est fixe par plateforme.
- `clear_all_browsing_data` (wry) n'attend pas la fin de l'effacement. Sur macOS, la purge passe
  par `WKWebsiteDataStore` avec son handler de complétion.
- Le CLI Tauri lance `npm list` pour vérifier les versions des paquets `@tauri-apps/*` pendant
  `tauri build`. Ce n'est pas un script du dépôt.

**Écarts restants pour D3.**
- Feux tricolores : la place réservée suit le zoom, mais les boutons ne sont pas déplacés selon
  le zoom comme sous Electron.
- Silhouette de démarrage : le script inline de `index.html` ne voit pas encore le pont.
- Écran « mise à jour requise » (426) : pas de bouton de mise à jour par le pont, seulement le
  lien de téléchargement.
- Manifeste par canal et variante, hébergement du flux (Q2).
- Menu contextuel : copie sur un champ mot de passe à vérifier, sinon menu maison.
- `navigator.clipboard` et le clic sur une notification à éprouver sur l'app signée.
- Google réel : un parcours avec de vrais identifiants OAuth sur un backend de test.
- Schéma `openedbot://` à déclarer au moment où l'app remplace Electron (même identifiant).
- Changer de backend efface aussi le thème et la taille du texte de l'appareil, qui ne sont
  reportés qu'à la déconnexion.
- Une configuration invalide arrête l'app sans dialogue (journal seulement).
- Le raccourci global peut être déjà pris par l'app Electron : le second inscrit perd.
- Linux et Windows : la purge n'a pas de confirmation (pause de 500 ms). La compilation Linux
  n'a pas été vérifiée ici, elle l'est par D5.
- Interface de mise à jour (pastille) branchée sur `UpdateState`. La console doit aussi
  appeler `report_update_required` sur un 426.
- Version de la bascule : 1.1.0 (dmg de D3).

**Reproduire.** `make desktop-tauri-check`, `make desktop-tauri-mac TAURI_VERSION=X.Y.Z
TAURI_POPUP=…/OpenedbotPopup.app`, `make desktop-tauri-feed`, `make desktop-tauri-publish
TAURI_VERSION=X.Y.Z`. L'app lit `OPENEDBOT_UPDATE_CHECK_SECONDS` pour une vérification
rapprochée.

### 4.4 Console : origine, plateforme, performance

**Découpler la console de son origine** (bloquant pour l'embarquement, O) :

- toute origine passe par l'adaptateur de plateforme : origine de l'API (runtime en desktop,
  section 4.3), URL publique de la console pour les liens d'invitation, les webhooks et
  `openInBrowser` ;
- un garde interdit `location.origin` et `window.location.origin` hors de l'adaptateur dans la
  console du cœur. Les plugins pro (par exemple
  `openedbot-pro/packages/pro-agency/console/screens/agency-invitation.tsx:62`) ne tournent que sur
  le web (section 4.2) et ne sont pas concernés ;
- un repli `index.html` pour les chemins profonds et les `location.replace` (6 sites) ;
- CSP : autoriser l'IPC de Tauri, sortir le script Umami du desktop ;
- zones de déplacement : `-webkit-app-region` vers l'attribut de Tauri.

**API, en face** :

- une **liste d'origines natives** distincte de `CORS_ALLOWED_ORIGINS`, qui alimente aujourd'hui
  aussi les origines de retour jugées fiables (`api-config.ts:397-406`). Les origines natives
  servent au CORS seulement, jamais de retour OAuth ;
- `tauri://localhost` (macOS, Linux) et `http://tauri.localhost` (Windows) sont les valeurs par
  défaut de Wry ; elles sont confirmées sur les binaires réels en D2 ;
- `"null"` n'est **jamais** autorisé. `new URL("tauri://localhost").origin` vaut `"null"` en
  JavaScript, ce qui explique `auth.ts:686` ; l'en-tête `Origin` réellement émis par WKWebView est
  mesuré au prototype ;
- `Access-Control-Expose-Headers: X-Request-Id`, `Access-Control-Max-Age`.

**Performance** (bénéficie aussi au web et à l'Electron actuel) :

1. Analyse du bundle d'abord (variantes solo desktop et web de production), puis chargement différé de
   `ConversationScreen`, `SupportPanel` et KaTeX, et imports ciblés de `ui-kit` au lieu du barrel.
   La réduction à une seule librairie d'icônes vient après, si l'analyse montre un gain (Q4).
2. Streaming : l'état du message en cours vit dans un store dédié auquel seul ce message
   s'abonne ; le découpage en blocs devient incrémental ; la timeline cesse de se re-rendre à
   chaque frame.
3. Longs fils : virtualisation de la timeline (faite en D1d, section 3.4).
4. L'interrogation d'un fil ouvert toutes les 5 s (`use-thread-stream.ts:237-249`) a une raison
   documentée (revue automatique) : elle n'est retirée qu'une fois S6 livrée et la couverture
   par événements prouvée. S6 est livrée ; la preuve de couverture (tout ce que relit cette
   interrogation passe-t-il par un événement ?) reste à faire, l'interrogation est gardée.
5. Garde en CI : budget du chunk d'entrée (script de contrat, comme le cliquet des 600 lignes).

### 4.5 Serveur : création des tours et états des runs

**Écritures de création centralisées.** `insert into runs` apparaît à **16 endroits** en
production (API 5, `execution/src/sql/runs.ts` 2, `routines.ts` 2, `runner/rooms.ts` 2,
`handoff.ts` 2, `workflows.ts` 2, `persist.ts` 1). Admission par l'utilisateur, routine, enfant
de workflow et handoff n'ont pas les mêmes invariants : une commande unique deviendrait un
nouveau monolithe. Cible : **plusieurs commandes explicites** dans `modules/execution`
(`admitUserTurn`, `fireRoutine`, `startWorkflowStep`, `handoff`…) qui partagent des primitives
transactionnelles privées ; un garde interdit toute écriture physique dans `runs` et `workflows`
hors de ces primitives. Le trigger de revue des messages privés
(`db/migrations/0091_run_admission_envelope.sql:43-60`) est conservé, ou remplacé dans la même
migration. L'inventaire S2a ([0002](0002-invariants-des-runs.md)) confirme les 16 écritures (plus
7 `insert into workflows` et celui du trigger), détaille leurs invariants et propose les commandes
de S2b ; il relève qu'un brouillon de persona (ou un run entrant de handoff hérité, ou un DM d'agence
dont l'initiateur a été effacé) en `unknown` n'a aucun chemin de revue (défaut D1, prouvé par
`tests/integration/orphan-unknown-runs.ts`). **Fait en S2b** ([0002](0002-invariants-des-runs.md),
section 9.1) : dix commandes (`admitUserTurnTx`, `branchTurnTx`, `admitWebhookDeliveryTx`,
`openWorkflowRetryTx`, `fireRoutineTx`, `queuePersonaDraftRunTx`, `greetNewBotTx`,
`startWorkflowStepTx`, `chainLegacyRoomTurnTx`, `openHandoffTx`) sur trois primitives privées
(`sql/run-writes.ts`) ; `tests/scripts/run-writes-contract.ts` interdit toute autre création et met
les 102 autres écritures de `runs` / `workflows` sous un cliquet daté pour S2d ; le trigger 0091 est
remplacé par 0175, qui ouvre la revue de tout run sans workflow passé en `unknown` (D1 corrigé).

**Transitions explicites.** Les changements de `runs.status`, `external_state` et
`remote_stop_state` (51 instructions `update runs`, dont 38 posent `status`, inventaire 0002
section 7) passent par une fonction de transition qui refuse une transition illégale et garde le
fencing par bail (`lease_owner`, `lease_generation`). **Fait en S2d**
([0002](0002-invariants-des-runs.md), section 9.3) : `modules/execution/src/sql/run-transitions.ts`
(`transitionRuns`) est le seul écrivain des trois colonnes. Il refuse avant d'écrire une transition
absente des tables de `domain/run-transitions.ts` (statut, état externe, arrêt distant) et garde
dans son `where` l'état d'origine et le bail du worker (propriétaire, génération **et échéance** :
un bail expiré n'écrit plus, même avant d'être repris) ; il rend les lignes qui ont bougé. Les autres
colonnes passent par des écritures nommées (`sql/run-columns.ts`). Les 66 `update runs` du cliquet
S2b en sortent tous ; la garde `run-writes-contract.ts` est stricte pour `runs`, et ne compte plus
que les 36 `update workflows` (cliquet daté). D4, D6 et D9 corrigés ; test
`tests/integration/run-transitions.ts` (deux workers, transitions illégales, D4, D6, D9).

**Événements.** Deux choses distinctes à préserver : la `sequence` par run (calcul
`max(sequence)+1` présent à 14 endroits sur `run_events`) et l'ordre de commit du curseur global.
L'inventaire (0002 section 5) les classe : 5 calculs dans une instruction qui suit la prise du
verrou du curseur de l'organisation, sérialisés par ce verrou ; 3 calculs dans **la même
instruction** que la prise du verrou (CTE de `queue.ts:88-108`, `runtime-direct.ts:87-106`,
`runtime-links.ts:149-168`), qui lisent un instantané antérieur à l'attente et perdent leur
événement en silence (`on conflict do nothing`, observé par une sonde) ; 6 calculs du worker
**hors transaction** (par exemple `provider-recovery.ts:346-350`), suivis de `persistEvents`, qui
verrouille le run (`persist.ts:208`) puis le curseur (`persist.ts:219`) sans recalculer et jette
une collision. Être « dans la transaction » ne suffit pas à sérialiser un `max+1`. Cible : une
seule primitive d'allocation qui prend **les deux verrous dans cet ordre**, puis calcule dans une
instruction séparée, dans la transaction qui insère, et un test de producteurs concurrents sur un
même run (section 5). **Fait en S2c** ([0002](0002-invariants-des-runs.md), section 9.2) :
`modules/execution/src/sql/run-events.ts` est le seul écrivain de `run_events` (`appendRunEventsTx`
alloue, `appendNumberedRunEventsTx` contrôle les séquences du flux du worker, déjà publiées avant
le commit, et refuse une collision par `RUN_EVENT_SEQUENCE_CONFLICT`) ; les 14 calculs et les
séquences en dur y passent ; garde `tests/scripts/run-events-contract.ts` ; test concurrent
`tests/integration/run-event-sequences.ts`, qui reproduit D2 et D3 sur le code d'avant.

**Découper `executeRun`** (fermeture de 1 250 lignes, `runner.ts:102-1357`) en étapes nommées :
préflight, création, streaming, approbations, repli de fournisseur, réconciliation. **Fait en S2e**
([0002](0002-invariants-des-runs.md), section 9.4) : `runner.ts` (1 331 lignes) devient une suite
d'appels de 91 lignes ; chaque étape est un module de `application/runner/` (`admission.ts`,
`preflight.ts`, `creation.ts`, `event-stream.ts` et `frame-events.ts`, `stream-fallback.ts`,
`approval-forwarding.ts`, `supervision.ts`, `settlement.ts`) qui reçoit ses entrées en arguments ;
le seul état partagé avec les minuteries est `RunState` (`run-state.ts`), passé explicitement.
Comportement identique (tests existants, golden inchangé) ; `runner.ts` sort du cliquet de taille.

### 4.6 Serveur : propriété de l'exécution, frontières, contrats, temps réel

- **Propriété de l'exécution.** `apps/api/src` crée 12 `HermesClient` (13 avec `scripts/seed.ts`),
  mais tous ne lancent pas un tour : certains sont des lectures (`runtime-provider-usage-routes.ts:109`,
  `runtime-model-context-routes.ts:93`). Faire passer ces appels par un port appelé depuis l'API
  laisserait l'effet dans l'API. Cible : séparer
  - les **lectures et l'administration** du runtime, qui restent synchrones via `modules/runtimes` ;
  - les **mutations d'exécution** (compaction, nouvelle version d'un message…), qui deviennent des
    commandes durables exécutées par le worker.
- **Frontières des modules.** Les exports de packages ne publient plus `./sql/*` ; un module
  n'importe un autre module que par sa couche `application` publique ; règles dependency-cruiser ;
  cycles de packages cassés (roster ↔ conversation, roster ↔ portability, runtimes ↔ runtime-link,
  identity → execution → roster → identity). **Avant** de restreindre les exports, les
  consommateurs pro des exports SQL (par exemple
  `openedbot-pro/packages/pro-agency/src/invitations.ts:17`, pro-staff, pro-billing) migrent vers
  des façades publiques, vérifiées par `make test-dual` et `make solo-check` (`Makefile:451-484`).
  Les ~670 lectures de tables étrangères sont gelées par un cliquet puis réduites.
- **Erreurs et contrats.** Erreurs de domaine dans les modules (code stable, sans statut HTTP ni
  texte français) ; `apps/api` fait la correspondance HTTP ; les clients traduisent par code.
  Schémas zod dans `contracts/api`, validés par un middleware. Ces deux règles s'appliquent **dès
  la première étape** à chaque route touchée, au lieu d'attendre une migration générale des 314
  `new HttpError` ; un cliquet suit le reste.
- **Temps réel multi-instances.** La diffusion vit dans un seul processus d'API (EventHub en
  mémoire, poller par organisation, alerte HTTP du worker vers une seule URL, repli à 5 s). Bun
  1.4 fournit `listen` et le worker l'utilise déjà pour la file, avec un repli par sondage
  (`run-queue-notifications.ts`) ; le commentaire « LISTEN non supporté » vise Bun 1.3. Cible : une
  connexion LISTEN par processus (chaque réplique d'API, chaque worker), avec réabonnement. Le
  trigger `pg_notify('openedbot_events')` (`0005_runs_workflows.sql:236-243`) est **gardé** et
  reçoit enfin un écouteur. Une notification ne fait que réveiller une lecture depuis le curseur
  durable : le journal et le rattrapage restent la source de vérité.

  **État S6 (livré).** Chaque processus d'API tient **une** connexion LISTEN dédiée sur
  `openedbot_events` (`apps/api/src/infrastructure/event-notifications.ts`). Une notification
  `<organisation>:<curseur>` réveille la pompe ordonnée de cette organisation, si un flux SSE de
  la réplique la suit ; chaque accusé de LISTEN (premier abonnement, puis chaque réabonnement que
  Bun refait seul après une coupure) réveille toutes les pompes, qui relisent depuis leur curseur.
  Les pompes vivent par hub (`routes/events/replay-pollers.ts`) et non plus dans un registre
  global au module, qui faisait publier deux instances d'un même processus dans le seul hub de la
  première. Le trigger 0005 n'a pas bougé : il est par ligne sur `run_events`, donc il notifie
  toutes les écritures de la primitive S2c (worker, API, plug-ins), au commit seulement ; les
  événements écrits par l'API elle-même (annulation, version d'un message, relance), qui
  n'avaient aucun réveil et attendaient le sondage de 5 s, arrivent maintenant en direct.
  `run_events` est la seule source du curseur du flux SSE ; `support_events` (guichet pro) garde
  son propre sondage, hors S6.

  Bun ne signale pas la perte d'une connexion LISTEN avant le réabonnement : un ping
  (`pg_notify` par le pool ordinaire, toutes les 5 s) prouve le lien de bout en bout et mesure son
  retard. Sans réponse, le lien est dit non confirmé. Le worker n'écoute pas ce canal (il ne lit
  pas le flux) ; il garde sa connexion LISTEN de file.

  L'alerte HTTP post-commit du worker est **gardée en repli** : l'API ne la suit que tant que
  son lien n'est pas confirmé (indisponible au démarrage, coupé, ping sans réponse), ce qui rend
  dans ce cas le comportement d'avant S6 au lieu de tout laisser au sondage. Le `POST` lui-même
  reste nécessaire pour les trames pré-commit (deltas sans curseur, qu'aucune table ne porte) ;
  le réveil post-commit y voyage déjà sans requête de plus. Retirer les `POST` qui ne portent
  qu'un réveil touche `modules/execution` (persist, cancel, failure, queue) : étape suivante.
  Le sondage de repli de l'API (`API_EVENTS_FALLBACK_POLL_MS`, 5 s) reste le filet.

  Observabilité, par processus : `GET /internal/metrics` porte `eventLink` (état, `connected`,
  abonnements, réabonnements, échecs, pings sans réponse, notifications, retard `lagMs` et
  `maxLagMs`) ; en Prometheus : `openedbot_api_events_listen_connected`,
  `openedbot_api_events_listen_{resubscriptions,failures,stalls,notifications}_total`,
  `openedbot_api_events_listen_lag_ms`. Journaux : `api.events_listener_ready` (`resubscribed`),
  `api.events_listener_failed` (essai, délai, `fallback: "poll"`), `api.events_listener_stalled`,
  `api.events_listener_recovered`, `api.events_listener_unsupported`. Aucune variable nouvelle.

### 4.7 Sécurité, protocole, observabilité

- **Changement de clé de l'appareil** (confirmé, `gateway.ts:417-467`). Sous le jeton de lien
  *courant*, un hôte peut proposer une nouvelle clé et prouver qu'il la possède ; l'ancienne clé
  n'est jamais exigée. Un voleur du jeton courant peut donc imposer sa propre clé. Cible
  (décidé le 2026-11-06, Q6) : refuser tout de suite un changement de clé implicite quand la
  clé proposée diffère de la clé enregistrée (les reconnexions avec la même clé ne changent pas) ;
  une machine qui a perdu sa clé repasse par l'inscription ; plus tard, une rotation signée par
  l'ancienne clé, négociée comme fonctionnalité du protocole. Avant de couper, compter les
  événements `rotated` / `device_key` du journal en production pour mesurer les hôtes touchés.
- **Secrets internes séparés.** `WORKER_INTERNAL_TOKEN` sert de bearer pour trois flux
  (publication d'événements, relais, signal d'inventaire) **et** de clé HMAC des clés de run.
  Cible : un secret par usage, la clé HMAC dérivée (HKDF) d'un secret maître distinct. La valeur
  de dev est déjà refusée en production par l'API et le gateway (`api-config.ts:554`) ; le worker
  exige une valeur mais n'interdit pas cette valeur précise (`apps/worker/src/config.ts:212-214`) :
  à aligner.
- **Contrat du connecteur unique.** `contracts/connector` et `protocol/connector` sont des
  copies ; les noms de fonctionnalités sont une liste en Go et des constantes éparses dans 10
  fichiers TS. Cible : `protocol/connector` fait foi, `contracts/connector` le réexporte, un test
  compare la liste Go à la liste TS.
  **État (S7, 2026-11-06)** : `protocol/connector` (`@openedbot/protocol-connector`, workspace de
  la racine) fait foi ; `contracts/connector` n'en garde que des réexports (prouvé par
  `protocol-allowlist-sync.test.ts`), le script de synchronisation ne copie plus le codec, et
  dependency-cruiser interdit à `protocol/` d'importer le dépôt. Les 28 noms vivent dans
  `protocol/connector/src/relay-features.ts` (`RELAY_HOST_FEATURES` dans l'ordre de priorité de
  l'hôte, `RELAY_LINK_FEATURES`) ; `relay-features.test.ts` lit `frames.go` et compare les deux
  listes, ordre compris, et refuse un nom écrit en dur ailleurs dans le code livré (vérifié par
  mutation des deux côtés). Déploiement : l'image de production doit désormais copier
  `protocol/connector` (Dockerfiles et `.dockerignore` du dépôt pro, qui l'excluent) ;
  `bun install --frozen-lockfile` échoue tant que ce n'est pas fait.
- **Corrélation de bout en bout.** Aucun identifiant ne traverse worker → gateway → connecteur
  → Hermes. Cible : `traceparent` transmis par le relais et ajouté à la liste blanche des en-têtes
  du connecteur ; logger commun dans le worker (aujourd'hui `console.info`).
  **État (S7, 2026-11-06)** : le trace-id d'un run est son UUID sans tirets
  (`platform/observability/src/trace-context.ts`) : il naît à l'admission (`run.admission`),
  sans colonne. Le worker ouvre le contexte de trace autour de chaque prise de run
  (`runWithTrace`, un span par prise) ; le mixin du logger colle `traceId`/`spanId` à chaque
  ligne écrite dedans, et le dialer du relais pose un `traceparent` neuf par requête
  (`worker.relay_request`). La passerelle le journalise (`runtime_link.relay_request`) et le
  relaie, le connecteur (Go) le valide, le journalise (`relay … trace=… span=…`) et le transmet
  au gateway Hermes ; une valeur invalide est écartée partout. Le worker passe entièrement par
  `@openedbot/platform-observability` (y compris le `log()` des étapes du runner) ; les lignes
  de l'API ne changent pas. Preuve : `tests/integration/run-trace-correlation.ts` (API, worker,
  passerelle et connecteur Go réels, Hermes factice : même trace-id et même span de
  `POST /v1/runs` partout) ; `make test-trace-legacy` rejoue la même preuve avec le connecteur
  publié v1.5.0, qui écarte l'en-tête sans rien casser. Point d'accroche après S2e : le
  contexte passe aujourd'hui par AsyncLocalStorage, sans toucher `runner.ts` ; une fois
  `executeRun` découpé en étapes nommées, chaque étape ouvrira son span enfant
  (`childTraceContext`) et journalisera son nom, et le contexte du run pourra être passé
  explicitement à `createRuntimeClient`.

### 4.8 Garde-fous du dépôt

- Le desktop entre dans les gardes : workspace Bun pour sa partie TS, `cargo clippy` et
  `cargo test` en CI, dependency-cruiser, `make check`.
- **Vérification pro** (Q3, non tranchée) : la recommandation reste un job CI qui construit et
  teste cœur + pro avec des références appariées, sans exposer de secret aux pull requests non
  fiables. Tant que ce job n'est pas autorisé, `make test-dual` et `make solo-check`
  (`Makefile:451-484`) sont lancés **en local** et leur résultat est consigné dans la pull request
  de chaque étape qui touche une surface utilisée par pro (D1a, S2b, S3, S4). Le desktop solo
  (section 4.2) réduit cette surface côté client.

## 5. Défaillances à traiter

| Scénario | Comportement attendu | Vérification |
|---|---|---|
| Desktop plus vieux que la version minimale de l'API | `426` + code stable, écran « mise à jour requise », bouton de mise à jour et lien de réinstallation | Test API + test du shell |
| Mise à jour : signature invalide, manifeste périmé, mauvaise architecture ou variante | Refus, version installée intacte, erreur journalisée | Tests du flux de mise à jour |
| Mise à jour : disque plein, app non inscriptible, popup encore actif | Refus avant d'écrire, popup arrêté avant le remplacement, message clair | Test sur machine de test |
| Nouvelle version qui démarre puis plante | Détection au lancement suivant, lien de réinstallation manuelle ; retour arrière à étudier en D3 (I) | Test en canal bêta |
| Perte ou rotation de la clé de mise à jour | Procédure écrite : nouvelle clé livrée par une version signée avec l'ancienne, sinon réinstallation manuelle | Exercice avant la bascule |
| Coffre indisponible (Linux sans Secret Service, Keychain verrouillé) | Session en mémoire seulement, message clair, jamais de jeton en clair sur le disque | Test Rust |
| Révocation distante ratée à la déconnexion | Session locale effacée quand même, échec journalisé | Test Rust |
| Deep link non enregistré | Repli sur la boucle locale | Test Rust |
| Popup notch absent, incompatible, ou qui plante en boucle | Arrêt immédiat si absent ou incompatible ; sinon 5 redémarrages avec délai, puis repli sur la fenêtre et dialogue | Test du protocole |
| Écran débranché entre deux lancements | Fenêtre ramenée sur un écran visible | Test Rust |
| Worker qui plante pendant la création, avant d'enregistrer l'identifiant Hermes | Run en `unknown` (`HERMES_CREATE_OUTCOME_UNKNOWN`, `queue.ts:270`), **jamais** relancé automatiquement : revue par l'utilisateur | Test d'intégration |
| Worker qui plante après l'enregistrement de l'identifiant, rejeu annoncé par l'hôte | Reprise par rejeu depuis `last_hermes_sequence`, sans doublon d'événement | Test d'intégration |
| Idem, rejeu **non** annoncé par l'hôte | Réconciliation par lecture du statut (`runner.ts:885`), puis `unknown` si l'issue reste incertaine ; l'arrêt propre du worker remet aussi le run en `polling` depuis S2d (D4) | Test d'intégration ; `run-transitions.ts`, partie 4 |
| Deux producteurs d'événements concurrents sur un même run | Séquences uniques et contiguës, curseur global ordonné | Test d'intégration concurrent |
| Run privé en `unknown` hors du trigger 0091 (sans initiateur, non racine, inséré directement en `unknown`) | Un chemin de revue existe, ou le cas est prouvé impossible. État S2b : insertion directe **impossible** en production (seule la primitive insère, statut `queued` ou `relaying`) ; tout run sans workflow qui passe en `unknown` reçoit son workflow de revue (0175) : DM racine, brouillon de persona, DM sans initiateur (agence), run entrant d'un handoff hérité, tour de salon hérité ; l'abandon libère fil, capacité et bot | `tests/integration/orphan-unknown-runs.ts` (S2a caractérisait D1, S2b prouve le chemin de revue) |
| Ancien worker qui écrit après expiration de son bail | Écriture refusée par le fencing, avant et après la reprise par un autre worker (S2d : le fencing compte aussi l'échéance du bail) | `tests/integration/run-transitions.ts`, partie 1 |
| Coupure de la connexion LISTEN | Réabonnement, rattrapage depuis le curseur durable. État S6 : `pg_terminate_backend` des deux connexions, porte TCP tenue fermée ; rien n'arrive pendant la coupure, puis les événements écrits entre-temps arrivent une fois chacun, dans l'ordre, au réabonnement (150 à 400 ms après le retour de la base, mesuré) | `tests/integration/realtime-listen.ts` (2) |
| Deux répliques d'API | Les deltas arrivent à tous les clients en < 1 s. État S6 : deux serveurs HTTP, deux hubs, deux connexions LISTEN ; le delta du worker (pré-commit vers la seule réplique visée) arrive commité à l'autre, et une écriture de l'API aux deux, en ~1 ms après le commit (local). En réel (2026-11-06, `make dev` sur develop en :8790 et une réplique de branche en :8797 sur la même base, réponse d'Atlas) : la réplique que le worker ne prévient pas reçoit chaque delta commité 6 à 21 ms (médiane 9 à 12) après la trame pré-commit de l'autre, sans doublon ; les événements écrits par l'API (`message.admitted`, `run.steering`) y arrivent 0,2 à 3,3 s plus tôt que sur develop | `tests/integration/realtime-listen.ts` (1) |
| LISTEN indisponible au démarrage | L'API démarre, journalise le repli, sert par le sondage, réessaie (1 s à 30 s) et s'abonne quand la base répond | `tests/integration/realtime-listen.ts` (3) |
| Jeton de lien volé | Ne permet plus d'imposer une nouvelle clé d'appareil | Test du gateway |

## 6. Plan par étapes

Chaque étape est une branche courte depuis `develop`, relue par `codex review --base develop`,
testée, puis fusionnée en squash. Deux pistes : **D** (desktop et console) et **S** (serveur).
Une étape ouverte par piste à la fois. Electron reste livrable jusqu'à D3.

```
 préalable :  P0 décisions restantes

 piste D :    D0 mesure --> D1a origines --> D1b chargement --> D1c streaming --> D1d virtualisation
                                 |
                                 v
              D2a prototype signé --> D2b parité macOS --> D3 release + bascule --> D4 Windows --> D5 Linux

 piste S :    S1 sûreté --> S2a..e tours et états --> S3 exécution --> S4 frontières --> S6 temps réel --> S7 corrélation
                                                                                             |
                                                                                             v
                                                                         retrait de l'interrogation à 5 s (console)
```

Dépendances entre pistes : D1a modifie l'API (origines natives, en-tête client) ; D3 dépend du
garde `426` livré en D1a ; le retrait de l'interrogation à 5 s attend S6 ; S4 attend la migration
des consommateurs pro. S5 n'est plus une étape : ses règles s'appliquent à chaque route touchée.

| Étape | Contenu | Critère de sortie |
|---|---|---|
| **P0** Préalables | Réponses à Q3 et Q7 (Q1, Q6, Q8 tranchées le 2026-11-06) | Q3 tranchée avant D1a ; Q7 avant D4 |
| **D0** Mesure | G1 (trois cas), G2, G3, G4 sur Electron et sur le web ; script rejouable | Chiffres consignés ici ; cibles confirmées ou corrigées |
| **D1a** Origines et plateforme | Adaptateur de plateforme, origine API runtime, URL publique, garde `location.origin` (console + pro), origines natives et en-tête client côté API, garde `426` | Web et Electron inchangés pour l'utilisateur ; garde au vert |
| **D1b** Chargement | Analyse du bundle (solo desktop et web de production), chargement différé, imports ciblés, budget en CI | G2 atteint ; mesure avant / après sous Electron |
| **D1c** Streaming | Store du message en cours, découpage incrémental | G4 atteint sur le web |
| **D1d** Virtualisation | Timeline virtualisée | Long fil fluide, aucune régression de lecture |
| **D2a** Prototype vertical signé | Console locale → auth bearer → SSE → notch → signature, notarisation, quarantaine → **vraie mise à jour** ; mesure de l'en-tête `Origin` ; entitlements | Le prototype installé depuis un dmg téléchargé se met à jour seul |
| **D2b** Parité macOS | Tableau de la section 4.3 entier, pont typé, tests de refus IPC | Parcours de test : connexion e-mail et Google, fil, streaming, notch, déconnexion, relance |
| **D3** Release et bascule macOS | Pipeline complet, canal bêta, puis bascule des liens de téléchargement | G1 et G3 mesurés sur l'app signée ; liens du site à jour ; Electron retiré pour macOS |
| **D4** Windows | WebView2, signature (Q7) | Build CI, installation et mise à jour d'un artefact téléchargé |
| **D5** Linux | WebKitGTK, deb et AppImage, lancement sous xvfb | Build CI + parcours de test ; perf WebKitGTK mesurée |
| **S1** Sûreté | Refus du changement de clé implicite (après comptage en prod) ; secrets séparés ; worker aligné sur le refus de la valeur de dev | Tests de la section 5 |
| **S2a** Inventaire | Inventaire des invariants des 16 écritures de `runs` ([0002](0002-invariants-des-runs.md)) | Document d'invariants relu |
| **S2b** Primitives de création | Primitives transactionnelles + commandes explicites ; trigger 0091 conservé | Garde : aucune écriture de `runs`/`workflows` hors des primitives |
| **S2c** Allocation d'événements | Une seule primitive : verrou du run puis verrou du curseur, puis calcul, dans la transaction qui insère | Garde sur `max(sequence)` hors primitive ; test de producteurs concurrents |
| **S2d** Transitions | Fonction de transition avec fencing | Tests des transitions illégales. **Fait** (2026-11-06) ; reste : transitions de `workflows` (cliquet daté) |
| **S2e** `executeRun` | Découpage en étapes nommées | Comportement identique (tests existants) + taille sous le cliquet. **Fait** (2026-11-06) |
| **S3** Propriété de l'exécution | Lectures vers `modules/runtimes` ; mutations en commandes durables du worker | Garde : l'API ne crée plus de `HermesClient` d'exécution |
| **S4** Frontières | Façades pour pro, exports restreints, cycles cassés, propriété des tables étendue à `apps/*`, cliquet sur les lectures étrangères | dependency-cruiser au vert ; `test-dual` et `solo-check` au vert |
| **S6** Temps réel | LISTEN par processus, trigger gardé, rattrapage durable | Tests LISTEN de la section 5 |
| **S7** Protocole et corrélation | Contrat du connecteur unique, `traceparent`, logger commun | Un run se suit d'un bout à l'autre dans les logs. **Fait** (2026-11-06) ; reste : publier edge-setup, copier `protocol/connector` dans l'image pro, spans par étape après S2e |

Chaque étape met à jour `CHANGELOG.md` (et `protocol/CHANGELOG.md` pour S1 et S7).

## 7. Risques

| Risque | Impact | Parade |
|---|---|---|
| WebKitGTK lent ou incomplet sur Linux | D5 bloquée | Linux en dernier ; Electron gardé pour Linux si la mesure de D5 est mauvaise |
| Différences de rendu WKWebView / WebView2 / Chromium | Régressions visuelles | Parcours de test et captures sur chaque moteur à D2b, D4, D5 |
| La console embarquée prend du retard sur l'API | Erreurs chez les utilisateurs desktop | Mise à jour signée + garde `426` + fenêtre de compatibilité |
| La chaîne de distribution (notch imbriqué, notarisation, mise à jour) bloque tard | Bascule repoussée | Prototype vertical signé dès D2a |
| Le chantier casse pro | Pro cassé sans alerte | `test-dual` et `solo-check` en local consignés dans chaque PR concernée (CI pro si Q3 l'autorise), façades avant S4 |
| Desktop solo : un utilisateur pro tombe sur un écran pro dans le desktop | Écran vide ou 404 | Renvoi « Ouvrir dans le navigateur » sur les préfixes de routes pro, testé |
| Couper le changement de clé implicite bloque des hôtes légitimes | Bots injoignables | Comptage en prod avant S1, procédure de réinscription documentée |
| Trop d'étapes en parallèle | Fusions conflictuelles | Une étape ouverte par piste |

## 8. Questions ouvertes

Recommandations issues de la revue Codex ; celles marquées **(décision)** attendent l'utilisateur.

| # | Question | Recommandation |
|---|---|---|
| Q1 **tranchée** | Session et brouillons à la bascule | Reconnexion unique ; perte des brouillons annoncée ; jamais Electron et Tauri connectés en même temps avec le même refresh token |
| Q2 | Hébergement du flux de mise à jour | R2 derrière une URL publique stable, artefacts immuables, manifeste par canal / architecture / variante, clé de signature hors de l'hébergement |
| Q3 **(décision)** | CI du cœur avec pro | Recommandé : job avec références appariées, sans secret exposé aux PR non fiables. En attendant : `test-dual` et `solo-check` en local (section 4.8) |
| Q4 | Librairie d'icônes à garder | Tabler (migration la plus petite), sous réserve de l'analyse du bundle, ui-kit et pro compris |
| Q5 | LISTEN | `listen` de Bun 1.4.4 d'abord ; un autre pilote seulement sur défaut reproductible |
| Q6 **tranchée** | Changement de clé d'appareil | Refus immédiat du changement implicite (après comptage en prod) ; réinscription si clé perdue ; rotation signée plus tard |
| Q7 **(décision)** | Windows | Signer avant de diffuser (certificat à acheter) ; la signature ne supprime pas à elle seule l'avertissement SmartScreen |
| Q8 **tranchée** | Variante desktop | **Solo** : pas de plugins console pro dans le desktop ; les routes pro renvoient vers le web (section 4.2) |

## 9. Ce qui n'est pas vérifié

WKWebView, la signature, la notarisation et la mise à jour sont vérifiés par le prototype D2a
(section 4.3.1), et la parité macOS par D2b (section 4.3.2). D2b n'a pas vérifié la vraie page
Google, le menu contextuel sur un champ mot de passe, `navigator.clipboard`, ni le clic sur une
notification à l'écran. Aucun test sur WebView2 ou WebKitGTK ni aucun test PostgreSQL concurrent n'a été
fait. Les autres points marqués `I` restent à confirmer.

## 10. Historique de revue

**Revue Codex n° 1 (2026-11-06)** — avis : « à corriger avant validation ». Corrections intégrées :

- Faux dans le cas courant : un message privé simple qui passe en `unknown` par un `UPDATE`
  reçoit un workflow de revue du trigger `0091_run_admission_envelope.sql:43-68`, réconciliable ou
  abandonnable. Le trigger ne résout pas l'incertitude : il donne un chemin de revue. Il exclut les
  runs sans initiateur, non racines, et ne s'applique pas à une insertion directe en `unknown` :
  ces cas restent à examiner (section 5, S2a). Retiré de S1.
- Faux : Bun 1.4 sait écouter LISTEN, et le worker l'utilise déjà avec un repli par sondage.
  S6 réécrite.
- Imprécis : 16 écritures de `runs` (et non 15) ; 12 `HermesClient` dans `apps/api/src`, pas tous
  d'exécution ; allocation de séquence et ordre du curseur sont deux sujets distincts.
- Déjà fait : la valeur de dev du secret interne est refusée en production par l'API et le
  gateway ; reste le worker.
- Ajouts : variantes solo / pro (4.2), origines natives séparées des retours OAuth, en-tête client
  dans le préflight, `"null"` jamais autorisé, bearer et `SameSite` préservés, permissions des
  commandes maison, entitlements, chaîne de signature du popup, défaillances de mise à jour,
  responsabilités Electron oubliées, perte des données locales à la bascule, consommateurs pro.
- Plan : préalable P0, prototype vertical signé au début de D2, D1 et S2 découpées, S5 dissoute
  dans chaque étape, dépendances entre pistes explicites, interrogation à 5 s gardée jusqu'à S6.
- Contre-propositions retenues : plusieurs commandes de création plutôt qu'un `startTurn` unique ;
  mutations d'exécution confiées au worker par commandes durables plutôt qu'un port appelé depuis
  l'API ; origine de l'API configurable au runtime plutôt que figée au build ; icônes après
  analyse du bundle.

**Revue Codex n° 2 (2026-11-06)** — avis : « pas encore prêt », trois précisions, intégrées :

- le trigger 0091 donne un chemin de revue, il ne résout pas l'incertitude ; ses cas exclus sont
  listés en section 5 ;
- l'allocation des séquences exige explicitement verrou du run puis verrou du curseur, avec un
  test de producteurs concurrents (4.5, S2c, section 5) ;
- la reprise après plantage du worker distingue trois cas (identifiant Hermes non enregistré,
  rejeu annoncé, rejeu non annoncé) pour ne jamais relancer une création incertaine.

**Décisions de l'utilisateur (2026-11-06)** : desktop solo (Q8), reconnexion unique avec perte
des brouillons annoncée (Q1), refus immédiat du changement de clé implicite (Q6). Q3 (CI pro) et
Q7 (signature Windows) restent ouvertes.

**Mesure de référence D0 (2026-11-06)** : chiffres en section 3.1. Cibles G1 à G4 corrigées. Le
démarrage local d'Electron est déjà sous 500 ms sur la machine de mesure (remesuré après la revue
Codex de l'outil, qui a corrigé le cas « après mise à jour » : 987 ms en réseau simulé) : G1 vise désormais
l'indépendance au réseau. G2 borne aussi le JS chargé avant la liste des fils (859 ko gzip
mesurés). G4 compte les frames longues (Long Animation Frames), l'API `longtask` ne rapportant
rien pendant le streaming.

**Inventaire S2a (2026-11-06)** : [0002](0002-invariants-des-runs.md). Chiffres confirmés (16
`insert into runs`, 14 `max(sequence)+1` sur `run_events`) ; section 4.5 précisée sur
l'allocation des séquences (le verrou du curseur sérialise les calculs faits après lui, pas ceux
faits dans la même instruction ni hors transaction). Un brouillon de persona, un handoff hérité ou
un DM d'agence sans initiateur en `unknown` n'a aucun chemin de revue (section 5, défaut D1), à
corriger en S2b. Relu par Codex (branche et document), corrections intégrées dans 0002.

**Primitives de création S2b (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md)
section 9.1. Les 16 créations passent par des commandes de `modules/execution`, sans changer leurs
colonnes, leurs verrous ni leurs événements ; garde `run-writes-contract.ts` (strict pour les
créations, cliquet S2d daté au 2026-12-31 pour les transitions) et règle dependency-cruiser
`primitives-de-creation-privees`. D1 corrigé (0175). Les routes touchées gardent leur contrat HTTP :
aucune ne change de corps de requête, et la seule erreur nouvelle (`WORKFLOW_SERVICE_RETRY_UNSUPPORTED`)
est rendue par l'API ; les commandes ne lèvent aucune erreur de domaine. Le dépôt n'a pas encore de
zod : les contrats zod de section 4.6 restent à poser avec leur middleware, dans une étape qui touche
le contrat d'une route.

**Prototype D2a (2026-11-06)** : résultats en section 4.3.1. WKWebView envoie
`Origin: tauri://localhost`, accepté par le CORS de D1a ; aucun entitlement ; mise à jour réelle
0.0.1 → 0.0.2 depuis un dmg notarisé, signature étrangère refusée. Le flux SSE manquait d'en-têtes
CORS (corrigé dans la même étape).

**Allocation d'événements S2c (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md)
section 9.2. Une primitive (`sql/run-events.ts`) prend la ligne de chaque run visé
(`for no key update`, qui ne bloque pas les clés étrangères), puis le curseur de l'organisation,
puis lit `max(sequence)` dans une instruction distincte, dans la transaction qui insère. D2 corrigé
(un `run.error` de balayage n'est plus perdu), D3 corrigé (une collision du flux devient une erreur
nommée ; la course réelle, un avis de complétion qui prenait la place d'un `tool.result.attached`,
n'est plus possible). Le balayage des runtimes connecteurs injoignables passe de `runtime-link` à
`execution`, propriétaire des tables qu'il écrit. Aucune migration.

**Transitions S2d (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md) section 9.3.
Une fonction (`sql/run-transitions.ts`) écrit seule `status`, `external_state` et
`remote_stop_state`, d'après une table déduite de 0002 section 7 et testée paire par paire ; le
fencing du worker ajoute l'échéance du bail au propriétaire et à la génération. Les 66 écritures de
`runs` du cliquet passent par elle ou par une écriture nommée ; la garde est stricte. Corrigés : D4
(arrêt du worker remis en `polling`), D6 (courrier clos sous garde : la double livraison est
reproduite sur le code d'avant), D9 (abandon et relance règlent l'état externe). D5, D7, D8, D10,
D11 restent ouverts (verrous de route, admission, données héritées). Aucune migration.

**Parité macOS D2b (2026-11-06)** : résultats en section 4.3.2. Le tableau de la section 4.3 est
couvert sur l'app signée et notarisée, à l'exception des points listés pour D3. L'état de mise à
jour est exposé par le pont et au notch. Plusieurs passes de `codex review` ont été faites ; leurs
findings P1/P2 ont été corrigés dans la branche :
- purge non confirmée, purges concurrentes ;
- écritures de préférences concurrentes ;
- réinstallation après « Plus tard » ;
- popup relancé pendant l'installation ;
- espace des feux au zoom du menu ;
- clic sur une notification ;
- processus de popup qui se chevauchent ;
- masquage d'une URL entre parenthèses ;
- refresh lancé avant la fenêtre.

**Découpage S2e (2026-11-06)** : section 4.5 et [0002](0002-invariants-des-runs.md) section 9.4.
`executeRun` passe de 1 331 à 91 lignes ; huit modules d'étape, aucun au-delà de 304 lignes, et un
état partagé explicite (`RunState`) pour les minuteries. Même ordre des écritures, mêmes verrous,
événements et journaux : les tests existants passent sans changement, le golden des portes est
inchangé ; tests ajoutés pour la complétion d'une trame et l'échéance du workflow. Relevé sans
correction : un double enveloppement du message de repli à la création, latent tant qu'un refus de
création ne peut pas être classé `quota`. Aucune migration.
