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
Le fichier privé `state.json` conserve les correspondances, l'idempotence,
les statuts et tous les événements. Chaque modification remplace atomiquement
cet état et le synchronise. Après redémarrage, tout run non terminal devient
`interrupted` ; les événements terminés restent disponibles, sans purge dans
ce paquet. Ne pas partager son dossier d'état entre plusieurs instances.

Les limites par défaut sont quatre runs, un tour par session, cinq minutes
d'inactivité, dix minutes par appel/tour ACP, cinq secondes pour terminer une
annulation et huit lignes stdout invalides par run. Un flot de lignes invalides
pendant l'initialisation est également borné. Le protocole lit au plus 1 MiB
par ligne ACP ; le pont garde au plus 128 KiB de texte de sortie et réserve
la place de l'événement terminal dans les limites du flux cloud. Un dépassement
échoue explicitement. Une panne ou un arrêt forcé de l'agent affecte les autres
runs actifs du même profil. Les profils ont des processus distincts, sans
prétendre fournir une isolation système entre eux. Le stderr de l'agent est
écarté ; les messages d'erreur JSON-RPC sont réduits à leur code numérique.

Le catalogue désigne uniquement `acp` / `agent-default`, le modèle configuré
dans l'agent. Un autre modèle, fournisseur ou des options de modèle échouent
explicitement. `systemPrompt` est envoyé en mode `append` à la création si
annoncé. Les changements ultérieurs passent dans un bloc texte ; sans cette
capacité, le premier tour reçoit aussi ce bloc. `session/load` est utilisé
seulement si annoncé, sans réinjecter l'historique de chargement dans le run.
Sinon une session neuve reçoit une fois l'historique cloud, dans son ordre,
et un `message.delta` indique la reconstruction, avec ou sans historique.

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
