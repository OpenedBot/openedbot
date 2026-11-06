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

## 4. Architecture cible

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
3. Longs fils : virtualisation de la timeline.
4. L'interrogation d'un fil ouvert toutes les 5 s (`use-thread-stream.ts:237-249`) a une raison
   documentée (revue automatique) : elle n'est retirée qu'une fois S6 livrée et la couverture
   par événements prouvée.
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
migration.

**Transitions explicites.** Les changements de `runs.status`, `external_state` et
`remote_stop_state` passent par une fonction de transition qui refuse une transition illégale et
garde le fencing par bail (`lease_owner`, `lease_generation`).

**Événements.** Deux choses distinctes à préserver : la `sequence` par run (calcul
`max(sequence)+1` présent à 14 endroits, parfois **avant** la transaction, par exemple
`provider-recovery.ts:346-351`) et l'ordre de commit du curseur global. Le code s'appuie
aujourd'hui sur deux protections distinctes : le verrou de la ligne du run (`persist.ts:208`), qui
sérialise le `max(sequence)+1` d'un même run, puis le verrou du curseur de l'organisation
(`persist.ts:219`). Être « dans la transaction » ne suffit pas à sérialiser un `max+1`. Cible :
une seule primitive d'allocation qui prend **les deux verrous dans cet ordre** avant de calculer,
dans la transaction qui insère, et un test de producteurs concurrents sur un même run (section 5).

**Découper `executeRun`** (fermeture de 1 250 lignes, `runner.ts:102-1357`) en étapes nommées :
préflight, création, streaming, approbations, repli de fournisseur, réconciliation.

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
- **Corrélation de bout en bout.** Aucun identifiant ne traverse worker → gateway → connecteur
  → Hermes. Cible : `traceparent` transmis par le relais et ajouté à la liste blanche des en-têtes
  du connecteur ; logger commun dans le worker (aujourd'hui `console.info`).

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
| Idem, rejeu **non** annoncé par l'hôte | Réconciliation par lecture du statut (`runner.ts:885`), puis `unknown` si l'issue reste incertaine | Test d'intégration |
| Deux producteurs d'événements concurrents sur un même run | Séquences uniques et contiguës, curseur global ordonné | Test d'intégration concurrent |
| Run privé en `unknown` hors du trigger 0091 (sans initiateur, non racine, inséré directement en `unknown`) | Un chemin de revue existe, ou le cas est prouvé impossible | Test d'intégration, à écrire en S2a |
| Ancien worker qui écrit après expiration de son bail | Écriture refusée par le fencing | Test d'intégration |
| Coupure de la connexion LISTEN | Réabonnement, rattrapage depuis le curseur durable | Test d'intégration |
| Deux répliques d'API | Les deltas arrivent à tous les clients en < 1 s | Test d'intégration à deux instances |
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
| **S2a** Inventaire | Inventaire des invariants des 16 écritures de `runs` | Document d'invariants relu |
| **S2b** Primitives de création | Primitives transactionnelles + commandes explicites ; trigger 0091 conservé | Garde : aucune écriture de `runs`/`workflows` hors des primitives |
| **S2c** Allocation d'événements | Une seule primitive : verrou du run puis verrou du curseur, puis calcul, dans la transaction qui insère | Garde sur `max(sequence)` hors primitive ; test de producteurs concurrents |
| **S2d** Transitions | Fonction de transition avec fencing | Tests des transitions illégales |
| **S2e** `executeRun` | Découpage en étapes nommées | Comportement identique (tests existants) + taille sous le cliquet |
| **S3** Propriété de l'exécution | Lectures vers `modules/runtimes` ; mutations en commandes durables du worker | Garde : l'API ne crée plus de `HermesClient` d'exécution |
| **S4** Frontières | Façades pour pro, exports restreints, cycles cassés, propriété des tables étendue à `apps/*`, cliquet sur les lectures étrangères | dependency-cruiser au vert ; `test-dual` et `solo-check` au vert |
| **S6** Temps réel | LISTEN par processus, trigger gardé, rattrapage durable | Tests LISTEN de la section 5 |
| **S7** Protocole et corrélation | Contrat du connecteur unique, `traceparent`, logger commun | Un run se suit d'un bout à l'autre dans les logs |

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

Aucun build Tauri, aucun test sur WKWebView, WebView2 ou WebKitGTK, aucun test PostgreSQL
concurrent, aucun essai de notarisation n'ont été faits. Les points marqués `I` et tout ce qui
concerne Tauri sont à confirmer en D2a.

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
