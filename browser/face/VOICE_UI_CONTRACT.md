# Contrat UI Voice

`src/voice-ui-state.ts` est la machine partagee des futurs rendus web et
natifs. Elle est pure et ne depend d'aucune API, permission navigateur ou
primitive native.

## Entree fail-closed

Un adaptateur doit prouver separement :

1. que le backend annonce la capacite Voice ;
2. qu'un microphone est disponible et autorise.

Une valeur absente se mappe sur `null`. L'absence du backend produit
`unsupported / VOICE_CAPABILITY_NOT_REPORTED`; l'absence de preuve microphone
produit `unsupported / VOICE_MICROPHONE_NOT_REPORTED`. Aucun bouton Start ne
doit etre rendu ou execute dans ces etats.

Sur le web, `apps/console/src/lib/voice/web-voice-recognition.ts` traite la presence
reelle de `SpeechRecognition` / `webkitSpeechRecognition` dans un contexte
securise comme la capacite de transcription. Il consulte `Permissions API`
quand elle sait repondre pour `microphone`, puis laisse le moteur demander
l'autorisation uniquement apres un geste utilisateur. Il ne lance pas un flux
`getUserMedia` de test et ne simule pas de backend quand l'API manque.

## Effets et donnees

La machine ne stocke aucun transcript, audio, blob ou URI. Ces donnees restent
dans l'adaptateur de plateforme. Celui-ci peut emettre `transcript.available`
uniquement apres avoir recu un transcript reel ; un timeout, une animation ou
une chaine de repli ne sont pas un transcript. C'est le seul passage de
`transcribing` a `sending`.

Avant chaque effet, le client consulte `voiceUiActions` puis rappelle
`voiceActionDecision`. Une resynchronisation qui retire la capacite backend ou
microphone remplace immediatement tout etat actif par `unsupported`.

Le rendu web conserve le texte confirme et provisoire hors de cette machine.
Une fin de reconnaissance le place en relecture : l'insertion dans le brouillon
et l'envoi sont deux gestes explicites. Aucun `onresult` ne demarre un run.

## Lecture des reponses sur le web

`apps/console/src/lib/voice/web-speech-synthesis.ts` utilise uniquement
`window.speechSynthesis` et `SpeechSynthesisUtterance`. Quand l'une des deux
primitives manque, le client ne rend aucune commande de lecture : il ne joue
pas un audio factice et n'appelle pas un backend de secours non configure.

Chaque bulle assistant terminee peut etre lue ou arretee. Une nouvelle lecture,
un changement de conversation et le demontage du fil annulent toute la file
native. Le Markdown est transforme en prose avant lecture : les liens gardent
leur libelle, les URL nues sont reduites a leur hote et le contenu des blocs de
code n'est jamais dicte. La voix de repli choisie par l'utilisateur est stockee
localement. Chaque bot peut aussi porter un `voiceId` persistant : s'il existe
dans le navigateur il prime pour ses reponses ; sinon la selection retombe sur
une voix de la langue courante. L'interface distingue `localService` d'un
service navigateur et avertit que, dans ce second cas, le texte peut etre
transmis au fournisseur vocal.

L'auto-lecture est desactivee par defaut. Quand elle est activee, le montage ou
le changement de conversation marque l'historique comme deja vu et seules les
nouvelles reponses terminees sont lues. Les deltas d'un stream ne sont jamais
lus un par un.

## Appel web half-duplex

Comme OpenMausBot, le message direct et le salon web proposent un appel
volontairement *half-duplex*. Chaque tour suit uniquement des evenements reels :

1. `SpeechRecognition` ecoute en mode one-shot ; l'endpoint de silence du
   navigateur termine le tour, avec un bouton d'envoi de secours ;
2. le transcript final est envoye par l'API de message ordinaire ;
3. l'UI attend le vrai run/workflow et les nouvelles reponses persistees du
   snapshot ;
4. le microphone est annule et detache avant tout `SpeechSynthesisUtterance` ;
5. la fin ou l'interruption explicite de la lecture ouvre un nouveau tour.

Dans un salon, le transcript est envoye tel quel : les `@mentions` suivent donc
le routage naturel du protocole de groupe. La session fige au demarrage le
roster `botId -> voiceId`, ce qui evite qu'un reordonnancement ou une suppression
attribue la voix d'un bot a un autre. Un nouvel auteur absent de ce roster utilise
la voix de repli du client. Les reponses du workflow attendu sont mises en file
dans l'ordre persiste, chacune avec la voix de son auteur. Le microphone reste
ferme pendant toute la file. Une reponse qui atteint le snapshot pendant la
lecture rejoint cette meme file ; un workflow entierement silencieux (`pass`)
reprend l'ecoute sans produire de bulle ou de parole factice. Le client refuse
une file depassant les plafonds serveur observables (10 messages, 18 tours) ; le
serveur reste la source du plafond de 3 rounds porte par `group_state`.

Un appel actif possede exclusivement la synthese du fil : auto-lecture et
speaker manuel sont suspendus. Fermer la modale, changer de mode ou raccrocher
invalide session, tour micro et callbacks TTS ; aucun callback tardif ne peut
rouvrir le microphone.

Une autorisation Hermes interrompt le cycle. Le prompt annonce l'action exacte
et les choix surs de la carte. Une decision est envoyee avec l'`approvalId`
observe seulement si le transcript correspond au libelle localise exact ; un
simple « oui », une demande expiree ou un choix inconnu arrete l'appel sans rien
autoriser.

Le duplex simultane reste indisponible sans pipeline media et AEC dedies ; aucun
faux duplex n'est affiche.
