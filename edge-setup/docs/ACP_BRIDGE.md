# Pont ACP : paquet de gateway

`internal/acpbridge` expose le contrat d'exécution de `protocol/SPEC.md` sous
`/p/<slug>`. `New(Options)` reçoit l'adresse IP loopback, le bearer, les dossiers
d'état et de profils, la commande de l'agent et les limites. `Serve(ctx)` gère
l'écoute HTTP ; le paquet est aussi un `http.Handler`. `Close()` termine les
processus et rend les runs interrompus lisibles. Une seule instance possède un
dossier d'état. Ce lot ne fournit ni commande, ni installation, ni unité système.

Un profil est un dossier existant, sans lien symbolique. Le pont ne démarre
l'agent qu'au premier tour, avec ce dossier comme répertoire de travail. La
création HTTP réserve la session cloud ; l'identifiant ACP est alloué avec le
premier tour pour pouvoir transmettre ses instructions dans `systemPrompt`.
Le fichier privé `state.json` conserve les correspondances de sessions et les
en-têtes des runs (identité, profil, session, clé d'idempotence, statut,
génération, compteurs et date terminale). Il ne contient ni événements ni texte
de sortie. Chaque run possède `events/<run_id>.jsonl`, un objet événement JSON
par ligne, ajouté sans réécrire le préfixe. Les événements restent en mémoire
pour les abonnements actifs ; au démarrage, ces fichiers reconstruisent le flux
et la sortie. Une dernière ligne incomplète après crash est tronquée avant de
reprendre l'ajout. Un événement terminal déjà présent prévaut sur un en-tête
plus ancien ; sinon un run non terminal devient `interrupted`.

Les chunks sont écrits sans fsync individuel. Les transitions d'état, y compris
les permissions et les fins, synchronisent les événements modifiés puis
remplacent atomiquement `state.json` et synchronisent ses dossiers. Les runs
terminés sont supprimés sept jours après leur événement terminal, au démarrage
et lors d'un balayage horaire. Les fichiers orphelins sont aussi supprimés.
`DELETE /api/sessions/{id}`, annoncé par `endpoints.session_delete`, supprime
la correspondance cloud de façon durable et annule son éventuel tour actif.
Les runs restent rejouables jusqu'à expiration ; le stockage propre à l'agent
reste sous sa responsabilité. Ce format remplace celui du prototype sans
migration. Une seule instance possède un dossier d'état.

Les limites par défaut sont quatre runs, un tour par session, cinq minutes
d'inactivité, trente secondes par appel de préparation ACP, trente minutes
par tour, cinq secondes pour terminer une
annulation et huit lignes stdout invalides par run. Un flot de lignes invalides
pendant l'initialisation est également borné. Le protocole lit au plus 1 MiB
par ligne ACP ; le pont garde au plus 128 KiB de texte de sortie et réserve
la place de l'événement terminal dans les limites du flux cloud. Un dépassement
échoue explicitement. Une panne ou un arrêt forcé de l'agent affecte les autres
runs actifs du même profil. Les profils ont des processus distincts, sans
prétendre fournir une isolation système entre eux. Le stderr de l'agent est
écarté ; les messages d'erreur JSON-RPC sont réduits à leur code numérique.

Le catalogue désigne uniquement `acp` / `agent-default`, le modèle configuré
dans l'agent. Un autre modèle ou fournisseur échoue explicitement. Le hint
`prompt_cache_ttl` (`5m` ou `1h` envoyé par le cloud) est ignoré sans modifier
le prompt. Les options de comportement `reasoning_effort`, `fast` et les
options inconnues échouent explicitement. `systemPrompt` est envoyé en mode `append` à la création si
annoncé. Les changements ultérieurs passent dans un bloc texte ; sans cette
capacité, le premier tour reçoit aussi ce bloc. `session/load` est utilisé
seulement si annoncé, sans réinjecter l'historique de chargement dans le run.
Sinon une session neuve reçoit une fois l'historique cloud, dans son ordre,
et un événement de métadonnées `context.rebuilt` indique la reconstruction
avec `history_restored` vrai ou faux. Aucun texte technique ne rejoint les
deltas de réponse ; leur concaténation reste égale à `run.completed.output`.

Les images demandent `promptCapabilities.image` et une URL `data:image/...`
avec base64. Une URL distante échoue explicitement : ce paquet ne télécharge
pas d'URL arbitraire. Les pensées, plans et compteurs cumulatifs sont ignorés.
Aucun usage par tour, transcript, steer, MCP, skills ou politique d'approbation
n'est annoncé. Les routes facultatives correspondantes répondent 404.
`once`, `deny` et éventuellement `always` ne sont proposés que si l'agent
fournit les options correspondantes. Il n'existe aucun choix `session`.
Une demande sans `allow_once` ou `reject_once` est annulée et le run échoue.
Les demandes ouvertes reçoivent `cancelled` à l'arrêt. Un arrêt demandé reste
`run.cancelled` même si l'agent termine par `end_turn` ; un agent qui ne répond
pas est arrêté après la limite d'annulation. L'arrêt du pont produit une
interruption, pas une réussite ou une relance automatique du tour.

Les tests utilisent un véritable sous-processus déterministe. Le test
`TestACPBridgeThroughConnectorRelayAndJournal` traverse le WebSocket du vrai
connecteur et son journal ; son côté cloud est le broker de test Go, pas le
broker TypeScript ni un service déployé. Les fixtures du lot 1 sont copiées
sous `test/golden/run-contract` et comparées par `make contract-check`.
Aucun agent réel ni aucune politique d'écriture sur un hôte n'a été validé.

## Formes ACP consultées

Source : schéma public ACP v1, téléchargé le 2026-11-17, hors du dépôt :
`https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json`.
SHA-256 : `e747a7bec3c02708b70885bf3cccac5c72fa421390dd7e85758fd61e33b1ae21`.
Le schéma n'est pas embarqué ni copié dans le dépôt.

| Forme utilisée | Définition du schéma (`$defs`) |
|---|---|
| Enveloppes `id`, `method`, `params`, `result`, `error`, identifiants chaîne ou nombre | `ClientRequest`, `AgentRequest`, `ClientResponse`, `AgentResponse`, `ClientNotification`, `AgentNotification`, `RequestId`, `Error`, `ErrorCode` |
| `initialize`, `protocolVersion:1`, `clientCapabilities` | `InitializeRequest`, `InitializeResponse`, `ProtocolVersion` |
| `fs.readTextFile:false`, `fs.writeTextFile:false`, `terminal:false` | `ClientCapabilities`, `FileSystemCapabilities` |
| `loadSession`, `promptCapabilities.image`, `sessionCapabilities.systemPrompt` | `AgentCapabilities`, `PromptCapabilities`, `SessionCapabilities`, `SessionSystemPromptCapabilities`, `SessionSystemPromptModeCapabilities` |
| `session/new`, `cwd`, `mcpServers:[]`, réponse `sessionId` | `NewSessionRequest`, `NewSessionResponse`, `SessionId` |
| `systemPrompt:{mode:"append",content:[...]}` | `SystemPrompt`, `SystemPromptMode` |
| `session/load`, `sessionId`, `cwd`, `mcpServers:[]` | `LoadSessionRequest`, `LoadSessionResponse` |
| `session/prompt`, `sessionId`, `prompt`, réponse `stopReason` | `PromptRequest`, `PromptResponse` |
| Blocs `{type:"text",text}` et `{type:"image",data,mimeType}` | `ContentBlock`, `TextContent`, `ImageContent` |
| `session/update`, `sessionId`, `update.sessionUpdate` | `SessionNotification`, `SessionUpdate` |
| `agent_message_chunk`, `agent_thought_chunk`, `content` | `SessionUpdate`, `ContentChunk` |
| `tool_call`, `toolCallId`, `title` ; `tool_call_update`, `status` | `SessionUpdate`, `ToolCall`, `ToolCallUpdate`, `ToolCallId`, `ToolCallStatus` |
| Statuts d'outil `pending`, `in_progress`, `completed`, `failed` | `ToolCallStatus` |
| `plan` et `entries:[]` ; `usage_update`, `used`, `size` (tests, sans projection) | `SessionUpdate`, `Plan`, `UsageUpdate` |
| `session/request_permission`, `sessionId`, `toolCall`, `options` | `RequestPermissionRequest`, `ToolCallUpdate` |
| `optionId`, `name`, `kind` ; `allow_once`, `allow_always`, `reject_once`, `reject_always` | `PermissionOption`, `PermissionOptionId`, `PermissionOptionKind` |
| `{outcome:{outcome:"selected",optionId}}` ou `{outcome:{outcome:"cancelled"}}` | `RequestPermissionResponse`, `RequestPermissionOutcome`, `SelectedPermissionOutcome` |
| `session/cancel`, `sessionId`, sans `id` | `CancelNotification`, `ClientNotification` |
| `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` | `StopReason` |

Les noms de méthodes viennent des attributs `x-method` des définitions.
Le champ d'enveloppe JSON-RPC `jsonrpc:"2.0"` relève de JSON-RPC 2.0 ; les
objets d'enveloppe de ce schéma ne le décrivent pas explicitement.

## Environnement de l'agent

Le processus reçoit uniquement `PATH`, `HOME`, `LANG`, `TERM` et les noms
supplémentaires de `Options.AgentEnvironment`. Une valeur contenant le bearer
est exclue même si son nom est explicitement autorisé. L'environnement complet
du pont n'est jamais transmis. Un agent exécuté sous le même utilisateur peut
encore lire les fichiers accessibles à cet utilisateur : l'unité qui exécutera
le pont doit garder le bearer hors de portée de l'agent. Cette unité appartient
à un lot ultérieur.

## Sonde de racine

Les quatre lectures `/health`, `/v1/capabilities`, `/v1/toolsets` et
`/api/model/options` fonctionnent aussi à la racine, même sans profil.
Les sessions et runs à la racine répondent HTTP 400 avec
`error.code: "profile_required"` et un message demandant `/p/<slug>`.
`platform/hermes/src/client/context.ts` classe ce 400 comme
`HERMES_RESPONSE_INVALID`, avec le corps dans le diagnostic du worker : ce
n'est ni un 401/403 de bearer, ni un 404 de profil, ni un 429 ou 503 réessayable.

## Délais de préparation et de tour

`Limits.RPCTimeout` borne séparément `initialize`, `session/new` et
`session/load` à trente secondes par défaut. `Limits.TurnTimeout` borne
`session/prompt` à trente minutes par défaut, au-dessus des quinze minutes du
cloud (`apps/worker/src/config.ts`, `WORKER_RUN_TIMEOUT_MS=900000`, appliqué
par `modules/execution/src/application/runner/supervision.ts` et identifié par
`RUN_TIMEOUT` dans `contracts/errors`). Si la limite cloud est personnalisée,
l'opérateur doit garder celle du pont au-dessus. L'expiration demande
`session/cancel` et annule les permissions ouvertes ; l'agent dispose de
`CancelTimeout` pour répondre avant son arrêt forcé. Le run finit `failed`
avec `ACP turn timeout`, même si la réponse est `cancelled` ou `end_turn`.
Une réponse coopérative conserve le processus partagé pour les autres sessions.

## Statuts d'outils

Un `tool_call` déjà `completed` ou `failed` produit immédiatement
`tool.started` puis `tool.completed` avec la même identité. Une mise à jour
terminale sans début connu est ignorée et incrémente
`unmatched_tool_completions`, conservé dans l'en-tête et exposé sur le statut
du run ; elle ne fait pas échouer le tour ni arrêter le processus partagé.

## Arrêt des descendants

L'agent démarre dans son propre groupe de processus (`Setpgid`), comme les
commandes hôte du paquet `internal/exec` sur Linux et macOS. Les chemins
d'arrêt forcé, de panne et de fermeture signalent ce groupe par `SIGKILL`,
y compris les shells et outils descendants qui en ont hérité. Le signal n'est
envoyé qu'une fois. La sortie du parent est détectée indépendamment du pipe
stdout : même si un enfant l'a hérité, le pont arrête le groupe puis draine
les messages déjà écrits avant de terminer les appels ACP. Le test attend la
fermeture d'une connexion possédée par un enfant, sans sondage par temporisation.

## Écritures ACP bornées

Chaque écriture vers stdin, y compris l'attente du tour d'écriture, est bornée
par `CancelTimeout` ; une échéance d'appel plus courte prévaut. Le pipe possède
une échéance d'écriture réelle. Un dépassement arrête le groupe de processus,
fait échouer les appels en attente avec `ACP stdin write timeout` et libère
l'écriture bloquée. Les réponses aux permissions et les annulations sont
collectées sous le mutex du pont puis envoyées après son relâchement.
Le journal conserve la décision d'approbation acceptée avant l'envoi ; un échec
d'envoi rend HTTP 502 et fait échouer le run, sans masquer le défaut de transport.

## Lecture des requêtes HTTP

Les corps sont lus intégralement (au plus 4 MiB) et les mutations sont validées
avant de prendre le mutex partagé. `BodyTimeout`, cinq secondes par défaut,
borne la lecture du corps par une échéance réseau et configure aussi
`http.Server.ReadTimeout`. Une lecture expirée reçoit HTTP 408 ; son échéance
reste active jusqu'à la fermeture de la requête pour borner aussi le drainage
HTTP. Les lectures réussies libèrent cette échéance. Un corps lent ne retient
ni les événements d'agent, ni `/health`, ni l'annulation d'un run.

## Rétention des sessions

Une session sans tour actif est supprimée après trente jours sans utilisation,
au démarrage et lors du balayage horaire des runs. `last_used` dans `state.json`
est mis à jour lors de la création ou confirmation HTTP de la session, de
l'admission d'un tour et de sa fin. Une session active est conservée même si
son horodatage est ancien. Un horodatage nul est expiré ; il n'y a pas de
migration du stockage de prototype.

Le cloud peut recréer une session supprimée par `POST /api/sessions` avant
son prochain run. Une session ACP neuve reprend alors, une seule fois,
l'historique cloud fourni, même quand aucune ancienne correspondance ACP ne
subsiste. Le pont émet `context.rebuilt` sans ajouter de texte à la réponse.
Une session ACP encore vivante continue d'ignorer l'historique déjà détenu.

Les lots sortants réservent leur position dans une chaîne propre à chaque agent
sous le mutex du pont. Hors mutex, chaque envoi attend la fin de son prédécesseur,
puis écrit au pipe ; un lot plus récent ne peut pas dépasser une approbation
acceptée avant son annulation. Cette attente fait partie de la même échéance
`CancelTimeout`. Si elle expire, les appels échouent et le groupe est arrêté.
