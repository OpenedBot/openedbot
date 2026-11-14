# Acceptation des bots Hermes

Les suites jouent de vraies actions sur le runtime lié à la stack locale.
`p0`, `p1` et `acceptance` imposent le mode strict : une capacité absente, une
réserve du modèle, une étape non jouée ou un nettoyage non prouvé ne valent
jamais un succès. Les six scénarios historiques restent disponibles par nom.

```sh
E2E_RUNTIME_ID=<id-du-runtime-lab> make e2e-bot-p0
E2E_RUNTIME_ID=<id-du-runtime-lab> make e2e-bot-p1
E2E_RUNTIME_ID=<id-du-runtime-lab> make e2e-bot SCENARIOS=acceptance
```

L'API doit être lancée avec son worker et son connecteur. Le runner vérifie
l'identité du runtime et que `WORKER_DATABASE_URL` permet de lire ce même
runtime avant de créer un bot. Il utilise les identifiants de développement
habituels (`LINK_DEV_*` / `E2E_*`), sans les écrire dans les rapports.
`--keep` est refusé pour les suites d'acceptation.

| Priorité | Scénario | Preuve exigée |
| --- | --- | --- |
| P0 | `tool-execution` | Nonce inconnu lu par les outils, transformation puis PDF téléchargé et vérifié indépendamment. |
| P0 | `browser-action` | Code construit dans le DOM, saisie et clic réels, reçu serveur lié au bot et au run. |
| P0 | `concurrency-idempotency` | Double POST, réponse perdue, rejeu et conflit de contenu : identités et réponse uniques ; deux fils restent séparés. |
| P0 | `interrupt-recovery` | Annulation distante, reprise SSE, redémarrage gracieux pendant un run et crash explicite ; le message suivant fonctionne. |
| P0 | `profile-isolation` | Mémoires et skills séparées ; même chemin absolu `/workspace` sans lecture ou écrasement croisé. |
| P1 | `memory-recall` | Fait écrit par l'outil, relu sur l'hôte, retrouvé dans une autre session après restart et absent du profil témoin. |
| P1 | `skills-mcp` | Skill créée puis utilisée ; MCP contrôlé appelé réellement, indisponibilité et révocation vérifiées. |
| P1 | `chat-reminders` | Demande dans le chat en mode Manuel, outil MCP réellement appelé, rappel actif à deux minutes, réponse dans le fil et aucune répétition. |
| P1 | `routines` | Horloge openedbot, occurrence unique rejouable, annulation d'une gate active et absence de déclenchement après pause. |
| P1 | `attachments-context` | Octets et pixels lus, détail inédit après restart, rejet sans admission d'une pièce invalide et compaction réelle. |
| P1 | `coordination-failures` | Spécialiste absent, boucle, budgets, annulation et timeout bornés, sans travail orphelin. |

## Rappels créés dans le chat

```sh
E2E_RUNTIME_ID=<id-du-lab> make e2e-bot SCENARIOS=chat-reminders
```

Le scénario utilise un profil jetable en mode Manuel. Il autorise **une fois**
le seul appel identifié qui crée son rappel, sans enregistrer de droit permanent.
Il attend réellement deux minutes, vérifie la réponse dans la conversation,
puis traverse la minute suivante pour vérifier l'absence de répétition.
La préparation MCP et le nettoyage du profil font partie de la durée totale.

En développement HTTP, le lab rappelle l'API par la boucle locale du tunnel
SSH installé par `make link-dev-up`. Le CLI doit annoncer
`mcp_development_callbacks`. Une URL HTTP fournie arbitrairement reste refusée ;
les autres environnements exigent HTTPS. Aucun domaine public n'est nécessaire
pour ce scénario local.

## Fixtures réseau et navigateur

Les fichiers et le navigateur utilisent une fixture Bun temporaire. Déclarer
une origine joignable **depuis le runtime et son sandbox**, le port local et
l'adresse d'écoute voulue :

```sh
E2E_RUNTIME_ID=<id-du-lab> \
E2E_FIXTURE_ORIGIN=http://<ip-lan-du-poste>:18871 \
E2E_FIXTURE_BIND=<ip-lan-du-poste> \
make e2e-bot SCENARIOS='tool-execution browser-action profile-isolation'
```

Le bind par défaut est `127.0.0.1`, le port `18871`. Le sandbox Docker interdit
volontairement le loopback du VPS : un simple tunnel vers ce loopback ne prouve
donc pas que les outils atteignent la fixture. Les routes aléatoires et les
nonces sont propres à chaque test ; le serveur est arrêté en `finally`.

Le MCP peut utiliser la fixture **stdio native du lab**, avec le pilote borné
qui appelle uniquement les verbes `edge-setup lab mcp-fixture`. Le binaire du
lab doit embarquer ces verbes. Ils exigent Linux, le runtime dev exact, un seul
connecteur actif et un profil temporaire E2E ; ils préservent la configuration
MCP racine. Le secret retourné par la fixture n'est jamais envoyé dans le prompt.

```sh
E2E_ALLOW_LAB_FIXTURES=1 \
E2E_PROVIDER=anthropic \
E2E_MODEL=claude-sonnet-4-6 \
E2E_MCP_FIXTURE_ARGV='["bun","tests/e2e/bot/lab-mcp-driver.ts","--host","lab-host-01","--instance","lab-instance"]' \
E2E_RUNTIME_ID=<id-du-lab> \
make e2e-bot SCENARIOS=skills-mcp
```

Ce chemin prouve le protocole MCP natif, l'indisponibilité et la révocation
avec arrêt des processus ; il ne prouve pas OAuth ou le transport HTTPS.
Épingler un fournisseur et un modèle authentifiés du catalogue du runtime ;
les valeurs ci-dessus sont un exemple de lab. Un refus du fournisseur reste
un échec. Le kit ne fait aucun fallback automatique : essayer un autre modèle
produit une nouvelle exécution avec sa propre provenance, sans modifier la
sélection globale du runtime. L'activation de configuration ne suffit pas : le
scénario attend le démarrage du processus MCP avant le premier tour, puis exige
l'alias natif et le reçu hôte indépendant.
L'alternative réseau exige une origine **HTTPS de confiance déjà configurée**, joignable par
Hermes, qui termine TLS et transfère `/<namespace>/mcp` vers le bind/port de la
fixture. La joignabilité LAN en HTTP ne suffit pas. Aucun certificat non fiable
ni changement de politique HTTPS n'est accepté pour faire passer le test. Les
étapes skills sont jouées avant ce contrôle ; le scénario reste en échec si le
MCP ne peut pas être prouvé.

`browser-action` cible par défaut le **navigateur du runtime Hermes** et annonce
explicitement cette portée dans son rapport. Hermes 0.23 exige aussi le toolset
`terminal` pour exposer `browser_exec` : le test active ce prérequis, puis
refuse tout appel direct à `terminal`, `process` ou un autre outil d’action.
Seuls `browser_exec` et la découverte en lecture seule `tool_search` sont
autorisés dans la trace. `E2E_BROWSER_TARGET=computer`
exige le contrôle de la Box : tant que le produit ne possède pas de contrôleur
attesté lié au bot/run, ce chemin échoue avec sa raison. Une capture d'écran ou
un formulaire ouvert sur le VPS ne prouve pas le contrôle de la Box.

Pour une fixture LAN avec le terminal Docker, Hermes refuse normalement les
adresses privées. Le lab réservé peut préparer une exception **sur le seul
profil E2E jetable**, avec un navigateur local épinglé et vérifié :

```sh
E2E_ALLOW_LAB_FIXTURES=1 E2E_LAB_EXCLUSIVE=1 \
E2E_BROWSER_FIXTURE_ARGV='["bun","tests/e2e/bot/lab-browser-driver.ts","--host","lab-host-01","--instance","lab-instance"]' \
E2E_RUNTIME_ID=<id-du-lab> \
E2E_FIXTURE_ORIGIN=http://<ip-lan-du-poste>:18871 \
E2E_FIXTURE_BIND=<ip-lan-du-poste> \
make e2e-bot SCENARIOS=browser-action
```

Le binaire edge-setup du lab doit embarquer `lab browser-fixture` avec le
contrat de preuve version 2 (`--schema-version 2`). Un ancien binaire refuse
ce drapeau avant toute mutation. Le helper
vérifie l'identité dev et le profil E2E, provisionne les octets Chromium dont
l'empreinte vient du commit Hermes épinglé, puis vérifie le démarrage sous
l'utilisateur Hermes dans une unité systemd utilisateur temporaire. Hermes
utilise son point d'accès CDP via le seul profil de test ; ce chemin ne teste
pas le lancement Bot Desktop dans l'image Docker. L'unité conserve le sandbox
natif Chromium et borne sa durée à dix minutes, sa mémoire à 1 Gio, son CPU
à un cœur et ses tâches à 256. Le durcissement du gateway reste inchangé.
Les fichiers du navigateur restent un cache géré root ; les champs de
configuration du profil sont restaurés en `finally`, depuis un reçu privé
avec contrôle des champs possédés. Le nettoyage vérifie aussi l'identité de
l'unité et du processus avant arrêt, puis l'inactivité et la disparition du
processus observé. Une reprise ne peut pas adopter une autre incarnation.
La configuration racine, les
clés des fournisseurs et les autres profils ne sont pas modifiés. Sur Debian 12/13 et Ubuntu 24.04, les bibliothèques manquantes sont installées
via APT sans suppression ni mise à niveau globale, avec vérification après
installation. Les paquets sains déjà installés ou retenus sont écartés de la
demande explicite ; le solveur APT peut ajuster des dépendances transitives.
Une dépendance indisponible ou un
démarrage impossible fait échouer la préparation.
Cette exception ne prouve pas le comportement par défaut du navigateur face
aux URL privées ; elle permet de tester le formulaire contrôlé du lab.

## Interruptions

Les redémarrages vérifient qu'aucun travail étranger n'est actif ou ambigu dans
la base observée. L'opérateur doit aussi réserver le lab : cette garde ne voit
pas le travail envoyé par un autre déploiement openedbot ou une autre surface
Hermes. Les premières phases utilisent les API existantes et des gates sur un
outil inoffensif, pour garantir que l'interruption chevauche un run actif.

Par défaut, tout tenant visible bloque un redémarrage. Après avoir vérifié que
le lab est dédié à l'instance testée, `E2E_LAB_EXCLUSIVE=1` limite cette recherche
au runtime explicitement sélectionné (un runtime par organisation). Cela évite
de confondre les fixtures d'autres runtimes avec du travail sur ce lab. Les
runs actifs ou ambigus d'un autre bot de ce runtime restent toujours bloquants.
Ce réglage ne constitue pas une preuve de réservation du serveur : il doit
être appuyé par l'inventaire de l'hôte et l'absence d'autres clients Hermes.

La preuve des dispatchs utilise `API_DATABASE_URL` (ou
`E2E_AUDIT_DATABASE_URL`) avec le tenant de la session. Le rôle worker n'a
volontairement pas accès à cette table d'audit ; ses droits restent inchangés.

La dernière phase exige un pilote de crash approuvé et explicitement nommé :
`E2E_ALLOW_RUNTIME_FAULTS=1` et `E2E_RECOVERY_ARGV` (tableau JSON d'exécutable et
d'arguments). Le runner ne devine ni commande SSH ni cible. Le pilote reçoit
uniquement les coordonnées système/SSH usuelles et les variables
`E2E_RECOVERY_{NONCE,RUNTIME_ID,BOT_ID,RUN_ID}` ; les secrets applicatifs ne lui
sont pas transmis. Il doit émettre un seul document JSON borné :

```json
{
  "schemaVersion": 1,
  "kind": "gateway-crash-restart",
  "nonce": "<nonce fourni>",
  "runtimeId": "<runtime fourni>",
  "signal": "SIGKILL",
  "stoppedObserved": true,
  "healthy": true,
  "before": { "pid": 100, "startedAt": "2026-11-09T00:00:00Z" },
  "after": { "pid": 101, "startedAt": "2026-11-09T00:00:01Z" }
}
```

Le pilote fourni pour le lab appelle la commande locale protégée ; il ne
permet aucune commande distante arbitraire :

```sh
E2E_ALLOW_RUNTIME_FAULTS=1 \
E2E_RECOVERY_ARGV='["bun","tests/e2e/bot/lab-crash-driver.ts","--host","lab-host-01","--instance","lab-instance"]' \
E2E_RUNTIME_ID=<id-du-lab> \
make e2e-bot SCENARIOS=interrupt-recovery
```

Les pilotes Bun sont lancés avec `--no-env-file`, en plus du filtrage des
variables héritées, pour empêcher le rechargement des secrets du dépôt.

Cette attestation opérateur est recoupée avec le timestamp de démarrage lu par
l'API, l'interruption du run et l'identité du dispatch. Elle ne constitue pas
un audit distant scellé. Le pilote est borné en durée et en volume de sortie ;
ses descendants sont arrêtés et son processus est récolté après usage. Sans
pilote approuvé, la phase échoue explicitement après les phases supportées.

## Résultats et vérification locale

Chaque lancement produit `tmp/e2e-bot/<date>-<label>/report.json` et
`report.html`, avec commit, versions annoncées Hermes/connecteur, modèle,
capacités, étapes, durées et nettoyage hôte. Les identités persistées openedbot
ne prouvent pas à elles seules le nombre de créations faites hors de son
connecteur ; voir aussi `../RUNTIME_LINK_CONTINUITY.md` pour l'audit indépendant.

```sh
bun test tests/e2e/bot/kit
make typecheck
```

Ces tests locaux vérifient notamment les refus de fausses preuves, les
frontières de protocole, les timeouts et les fixtures. Ils ne remplacent pas
l'exécution des scénarios sur le lab.

## Placement attesté du navigateur de fixture

Le backend lab navigateur exige une unité utilisateur dédiée à la fixture,
exécutée sous l’utilisateur Hermes en dehors de l’unité gateway. Chromium
conserve sa sandbox native. Le contrat CLI doit attester explicitement
`schemaVersion: 2`, `placement: "user-unit"`, l’unité, l’invocation, l’identité PID/startTicks et
les limites de ressources vérifiées ; l’ancien contrat sans ces preuves est
refusé. Le pilote envoie `--schema-version 2` au CLI distant ; une ancienne
version refuse ce flag avant toute mutation et le nouveau CLI exige cette
version explicite. Aucune URL CDP n’est incluse dans les preuves publiques du pilote.

L’exception d’URL privée et la liaison au navigateur restent limitées au
profil E2E possédé. Après settlement du seul thread de test, le nettoyage
vérifie la restauration des champs possédés, l’inactivité de l’unité et la
disparition du processus identifié. Une réponse perdue est réconciliée par
le reçu exact, sans suppression aveugle. Cette préparation ne constitue pas
la preuve de l’action : seuls `browser_exec` et la découverte `tool_search`
sont autorisés dans la trace ; le formulaire et son reçu serveur doivent
rester liés au bot et au run. Cela ne prouve pas le contrôle de la Box.

### Inspection manuelle d’un scénario en échec

`E2E_FAILURE_INSPECTION_MS=120000` conserve temporairement les profils du cas en
échec avant leur purge, pendant au maximum deux minutes. La valeur par défaut est
`0` ; seules les valeurs entières de `0` à `120000` sont acceptées. Un cas réussi
ne s’arrête pas. Le verdict, les assertions et le nombre d’appels restent inchangés.

Le runner indique uniquement le scénario, le runtime, le tag du BotLab et le chemin
`<outDir>/inspection-<scenario>.release`. Créer ce fichier termine la pause plus tôt.
Une même exécution de scénario ne fait qu’une pause, même si elle demande
l’inspection avant son propre nettoyage puis rejoint le nettoyage du runner.
Cette fenêtre sert à une inspection manuelle en lecture seule ; les blocs `finally`
propres au scénario peuvent déjà avoir supprimé ses groupes. La purge des bots et
le contrôle du nettoyage hôte suivent toujours, y compris si la pause échoue.
Un échec du mécanisme émet uniquement un motif borné (`configuration`,
`filesystem`, `clock`, `sleep` ou `logging`), sans message brut.
Aucune sortie de modèle ni contenu de pièce jointe n’est ajouté aux logs.

## Gate de release

L’acceptation bot est une partie de la recette de release.
Le verdict complet exige un candidat unique, la matrice hôte, le reboot réel,
l’upgrade/rollback et les clients web/desktop N-1 et N connectés à l’API N.
Un canary de mise à jour desktop déconnecté ne remplace pas ce dernier parcours.
