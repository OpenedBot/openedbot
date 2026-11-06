# 0002 — Invariants des écritures de `runs` (inventaire S2a)

- **Statut :** inventaire S2a de l'ADR [0001](0001-refonte-tauri-et-produit.md) (section 4.5, étapes
  S2a à S2e) ; **S2b réalisé** (section 9.1), **S2c réalisé** (section 9.2) : les références
  `fichier:ligne` des sections 3 à 8 décrivent l'état d'avant S2b
- **Date :** 2026-11-06
- **Référence :** `develop` au commit `c1edc11`. Toutes les références `fichier:ligne` pointent ce
  commit ; `O` = observé dans le code ou par un test, `I` = déduit, à confirmer
- **Preuve exécutable :** `tests/integration/orphan-unknown-runs.ts` (cible `make test-integration`),
  qui caractérisait D1 en S2a et prouve sa correction depuis S2b ;
  `tests/integration/run-event-sequences.ts`, qui reproduit D2 et D3 sur `develop` d'avant S2c et
  prouve leur correction
- **Entrée de :** S2b (primitives de création), S2c (allocation d'événements), S2d (transitions)

Ce document recense chaque écriture qui crée un run (et le workflow qui l'accompagne), la façon
dont les événements reçoivent leur `sequence`, les transitions de `runs.status`, `external_state`
et `remote_stop_state`, puis les défauts relevés. Il ne change aucun comportement.

## 1. Chiffres vérifiés

Comptés avec `rg` sur le code de production (`apps/`, `modules/`, `platform/`, hors tests, docs et
migrations).

| Affirmation de l'ADR 0001 | Vérifié | Commande, remarque |
|---|---|---|
| 16 `insert into runs` | **16** (O) | `rg -n -U -i "insert\s+into\s+(public\.)?runs\b"` : API 5, `sql/runs.ts` 2, `routines.ts` 2, `rooms.ts` 2, `handoff.ts` 2, `workflows.ts` 2, `persist.ts` 1. Aucun dans `scripts/`, ni dans le code de production de `openedbot-pro` (seulement ses tests) |
| — | **7** `insert into workflows` + **1** dans le trigger 0091 (O) | Section 4 |
| 14 calculs `max(sequence)+1` | **14** sur `run_events` (O) | `rg -n -U -i "max\(\s*(\w+\.)?sequence\s*\)"` donne 17 lignes : 2 portent sur `messages.sequence` (`compact-room-request.ts:76`, `rooms.ts:586`) et 1 est un commentaire (`hermes-events.ts:195`) |
| — | **3** séquences écrites en dur (0 ou 1) sur un run neuf (O) | Section 5 |
| — | **51** instructions `update runs` changent `status`, `external_state` ou `remote_stop_state`, dont **38** posent `status` (O) | Section 7. Aucune écriture de `runs` dans les fonctions SQL des migrations |

## 2. Ce que la base garantit déjà

| Garde | Où | Ce qu'elle tient |
|---|---|---|
| `runs_status_check` | `0005_runs_workflows.sql:62` | 9 statuts : `queued`, `starting`, `running`, `awaiting_approval`, `relaying`, `unknown`, `completed`, `failed`, `cancelled` |
| `runs_external_state_check` | `0005_runs_workflows.sql:69` | `not_started`, `creating`, `streaming`, `polling`, `stopping`, `settled`, `ambiguous` (défaut `not_started`) |
| `runs_remote_stop_state_check` | `0005_runs_workflows.sql:73` | `null`, `requested`, `confirmed`, `ambiguous`, `failed` |
| `runs_step_kind_check` | `0020_thread_compactions.sql:9` | `null`, `root`, `delegated`, `continuation`, `group`, `memory`, `persona_draft`, `compaction` |
| `runs_one_active_per_thread_idx` | `0005_runs_workflows.sql:104` | un seul run `starting`/`running`/`awaiting_approval`/`relaying`/`unknown` par fil ; `queued` n'y est pas |
| `runs_workflow_step_idx` | `0005_runs_workflows.sql:202` | `(workflow_id, step_index)` unique |
| `workflows_root_run_fkey` différée | `0005_runs_workflows.sql:175` | le run racine doit exister au commit ; l'insertion commune dans une transaction, dans n'importe quel ordre, est une convention des producteurs que la FK différée rend possible |
| `workflows_used_steps_within_budget` | `0005_runs_workflows.sql:163` | `used_steps <= max_steps` |
| `runs_final_status` (0081) | `0081_runs_final_status.sql:28-32` | `completed` et `failed` sont finaux ; `cancelled` ne l'est pas |
| `runs_plain_dm_review_workflow` (0091) | `0091_run_admission_envelope.sql:33-69` | ouvre un workflow de revue `dm`/`unknown` quand un run **passe** en `unknown` par un `UPDATE`, sauf s'il a déjà un workflow, n'est pas `root`, ou n'a pas d'initiateur (`:43-47`) |
| `run_events_stamp_identity` (0092) | `0092_run_events_identity.sql:66-116` | `bot_id`, `turn_id`, `session_key`, `lease_generation` déduits du run ; un écrivain qui fournit `lease_generation` est refusé (23514) si le bail a changé |
| `run_events (organization_id, run_id, sequence)` unique | `0005_runs_workflows.sql:226` | pas de doublon de séquence ; 9 des 12 `insert into run_events` ajoutent `on conflict do nothing`, sauf `run-receipts.ts:114`, `run-cancellation.ts:284` et `message-version-routes.ts:353`, qui échouent sur un doublon |
| `runs_initiator_user_fkey` | `0171_deletion_and_blob_integrity.sql:163` | `initiator_user_id` → `users(id)` `on delete set null` |
| `runs_queue_wakeup` (0095) | `0095_worker_run_queue_unblock_notifications.sql:24` | se déclenche sur ces colonnes, mais ne notifie (`:7-19`) qu'une insertion `queued`, un run qui (re)devient `queued` ou change de `next_attempt_at` / `remote_stop_state` en file, et un run actif, `relaying` ou `unknown` qui en sort ou perd son bail (pas `starting` → `running`, ni l'insertion d'un courrier) |

Ce que la base **ne** garantit **pas** : le statut initial (rien n'interdit d'insérer en
`unknown`, le trigger 0091 étant `before update of status`), la cohérence `step_kind` / workflow /
initiateur, la présence d'une enveloppe d'admission (`deadline_at`) hors workflow, l'ordre des
verrous, le fencing des transitions (chaque `update` porte sa propre garde).

`runs` n'a pas de colonne de visibilité : un run « privé » est un run de fil DM (`threads.bot_id`,
le fil par défaut du bot ou un fil secondaire), par opposition au fil de salon
(`threads.group_id`). Le brouillon de persona tourne dans un fil à part, retrouvé par sa clé de
session (`modules/roster/src/sql/bot-activity.ts:157-169`).

## 3. Les 16 créations de runs

### 3.1 Colonnes posées

Colonnes jamais posées à la création : `lease_owner`, `lease_expires_at`, `lease_generation`
(défaut `0`), `hermes_run_id`, `remote_stop_state` (`null`). Le bail n'existe qu'à la réclamation
(`queue.ts:445-451`). `external_state` vaut `not_started` partout (posé explicitement ou par
défaut), `events_complete` vaut `true`.

| # | Écriture | Appelant | Statut | `step_kind` | Workflow | Initiateur sur le run | Parent / racine | Enveloppe sur le run |
|---|---|---|---|---|---|---|---|---|
| 1 | `apps/api/src/routes/conversation/conversation-message-routes.ts:430` | `POST /threads/:id/messages` (DM simple, salon, mention `@slug`, repli de steer, remplacement) | `queued` | `root`, `group` ou `delegated` | ouvert à `:418` si salon, mention ou autonomie, et pas de steer ; sinon aucun | `auth.userId` | racine ; `caller_bot_id` si mention | `deadline_at` seulement sans workflow (`:438`), `plan_only` |
| 2 | `apps/api/src/routes/conversation/message-version-routes.ts:333` | `POST …/messages/:id/versions` (variante ou régénération, nouveau fil) | `queued` | `root` ou `delegated` | toujours, `:319` | aucun (sur le workflow) | racine du workflow | `plan_only` ; `never_wait` sur le workflow |
| 3 | `apps/api/src/routes/webhooks/sql.ts:556` (`insertQueuedRun`) | `POST /api/hooks/:organizationId/:endpointId` (`webhook-ingress-routes.ts:48`, montée à `apps/api/src/index.ts:349` ; insertion `:160`) | `queued` | `root` ou `group` | toujours, `sql.ts:528` | aucun (`endpoint.createdByUserId` sur le workflow) | racine | aucune |
| 4 | `apps/api/src/routes/execution/workflow-routes.ts:388` | `POST /workflows/:id/retry` (relance avec risque de doublon) | `queued` | celui du run racine relancé, `root` s'il était nul (`:395`) | toujours, `:375` (`recovery_state.retryOf`) | aucun (sur le workflow) | racine ; copie `caller_bot_id`, `source_message_id` | `plan_only` ; `never_wait` sur le workflow |
| 5 | `apps/api/src/routes/execution/routine-routes.ts:503` | `POST /routines/:id/runs` (lancement manuel) | `queued` | `root` ou `group` | toujours, `:489` | aucun (sur le workflow) | racine | `never_wait` sur le workflow |
| 6 | `modules/execution/src/sql/runs.ts:16` (`insertPersonaDraftRun`) | `queuePersonaDraft`, `modules/roster/src/application/persona-drafts.ts:50` | `queued` | `persona_draft` | **aucun** | **aucun** | aucun | **aucune** (`deadline_at` nul) |
| 7 | `modules/execution/src/sql/runs.ts:41` (`insertBotGreetingRun`) | `createBot`, `modules/roster/src/application/bots.ts:261` (accueil d'un bot neuf) | `queued` | `root` | aucun | l'opérateur | racine | `deadline_at` = timeout d'autonomie du bot ; `origin = 'bot_greeting'` |
| 8 | `modules/execution/src/application/routines.ts:314` (`fireDirectOccurrence`) | `fireDueRoutine` (worker, routine planifiée d'un bot) | `queued` | `root` | toujours, `:296` (`kind = 'routine'`) | aucun (`created_by_user_id` sur le workflow) | racine | `never_wait` sur le workflow |
| 9 | `modules/execution/src/application/routines.ts:389` (`fireGroupOccurrence`) | `fireDueRoutine` (routine planifiée d'un salon) | `queued` | `group` | toujours, `:374` | aucun | racine | `never_wait` sur le workflow |
| 10 | `modules/execution/src/application/runner/rooms.ts:661` (`advanceGroupTx`) | tour de salon suivant : `persist.ts:421`, `:509`, `queue.ts:637` | `queued` | `group` (ou `null` si le run courant n'a pas de workflow) | celui du run courant ; `used_steps + 1` | aucun | même workflow, `step_index + 1` | celle du workflow |
| 11 | `modules/execution/src/application/runner/rooms.ts:701` (`advanceLegacyGroupTx`) | ancien chaînage de salon, `queue.ts:650` | `queued` | `null` | aucun | aucun | aucun | aucune |
| 12 | `modules/execution/src/application/runner/handoff.ts:151` (run entrant) | `createHandoffTx`, `persist.ts:452` (mention `@slug` dans la réponse d'un DM **hérité** sans `step_kind`, voir 3.1) | `queued` | `null` | **aucun** | **aucun** | `origin_run_id` = courrier | **aucune** |
| 13 | `modules/execution/src/application/runner/handoff.ts:159` (courrier) | `createHandoffTx`, même transaction que 12 | `relaying` | `null` | aucun | aucun | `handoff_target_bot_id` ; `bot_id` nul | aucune |
| 14 | `modules/execution/src/application/runner/workflows.ts:126` | `advanceWorkflowCompletionTx`, `persist.ts:442` (délégation acceptée) | `queued` | `delegated` | celui du parent ; `used_steps + 1`, `used_handoffs + 1` | aucun | `caller_run_id`, `caller_bot_id`, `stack_depth + 1`, `step_index = used_steps` | celle du workflow |
| 15 | `modules/execution/src/application/runner/workflows.ts:335` (`createWorkflowContinuationTx`) | résultat ou échec d'une étape déléguée : `workflows.ts:193`, `:288` (via `persist.ts:442`, `:517`, `queue.ts:632`, `:659`) | `queued` | `continuation` | celui de l'étape ; `used_steps + 1` | aucun | `resumes_run_id`, appelant du parent, `stack_depth - 1` | celle du workflow |
| 16 | `modules/execution/src/application/runner/persist.ts:436` | ancien chaînage de salon dans `persistEvents` (run de salon sans `group_state` ni workflow) | `queued` | `null` | aucun | aucun | aucun | aucune |

Remarques (O) :

- **Statut initial** : `queued` partout, sauf le courrier (`relaying`), toujours en littéral. Le
  test `orphan-unknown-runs.ts` le vérifie sur les 16 écritures et échoue si une 17e apparaît.
- **`memory` et `compaction`** sont encore acceptés par la contrainte et filtrés dans plusieurs
  gardes (`run-cancellation.ts:246`, `modules/roster/src/sql/bots.ts:507`) mais **aucune écriture
  ne les crée** : ce sont des types morts.
- **11 et 16** ne partent que d'un run de salon sans `group_state` ni workflow. Toutes les
  entrées actuelles d'un salon (envoi, webhook, routines) ouvrent un workflow : ces deux écritures
  ne servent que des données d'avant le salon à workflow (I : à compter en prod avant de les
  retirer).
- **10** pose `step_kind = null` et `workflow_id = null` quand le run courant n'a pas de workflow,
  c'est-à-dire seulement pour les mêmes données héritées.
- **12 et 13 (handoff par courrier)** ne partent que d'un DM sans workflow ni `step_kind` : la
  branche de `persist.ts:445` vient après `simpleDmStep` (`persist.ts:443`, `handoff.ts:91-99`),
  qui capte tout DM racine sans workflow et refuse la délégation (`workflows.ts:221-226`) ; les
  runs de service (`persona_draft`) n'ont pas de message (`run-step.ts:14`). Aucune admission
  actuelle ne crée un tel DM : le courrier ne sert que des runs d'avant 0091 (I : à compter en
  prod). Une mention `@slug` actuelle passe par un workflow (`delegated`, création 1 ou 14).

### 3.2 Transaction et verrous

| # | Début de transaction | Verrous, dans l'ordre | Événements émis, séquence |
|---|---|---|---|
| 1 | `admitWithStoredBlobs`, `conversation-message-routes.ts:101-105` | abonnement `for update` (pro seulement, `:106`) → fil `for update of t` (`:150`) → run choisi par `followupDispositionTx` (`:277`) → bots requis `order by id for update` (`:376`) → si `supersede`, runs, workflows et approbations de l'ancien tour (`requestRunCancellationTx`, `:459`, `run-cancellation.ts:66-98`, `:151-159`) → si mention : curseur de l'organisation (`:492`) puis fil DM de la cible (`update threads`, `:509-510`) → reçus : runs concernés `for key share` (`run-receipts.ts:103-106`) puis curseur (`:599`, `run-receipts.ts:109`) | mention : 2 `system.notice` aux séquences **0 et 1 en dur** (`:497`, `:503`) ; puis `message.admitted` par `recordRunReceiptsTx` (`:599`, `run-receipts.ts:109-115`, `max+1`) |
| 2 | `withTenant`, `message-version-routes.ts:136` | abonnement (`:137`) → fil source `for update of thread` (`readSource`, `message-version-source.ts:47`) → verrou consultatif de la famille (`:157`) → bot racine `for update` (`:206`) → cible `for key share` (`:300`) → curseur si mention (`:351`) | mention : 1 `system.notice` à la séquence **0 en dur** (`:353`), sans `on conflict` |
| 3 | `withTenant`, `webhook-ingress-routes.ts:65` | point d'entrée et fil `for update of e, t` (`sql.ts:96`) → livraison réservée (`on conflict do nothing`, `sql.ts:298`) → abonnement (`webhook-ingress-routes.ts:96`) → fil `for update of t` (`sql.ts:426`) → bot `for update` (`sql.ts:504`) | aucun |
| 4 | `withTenant`, `workflow-routes.ts:249` | fil `for update` (`:258`) → runs du workflow `order by id for update` (`:427`) → workflow `for update` (`:418`) → bots `order by id for update` (`:345`) | aucun |
| 5 | `withTenant`, `routine-routes.ts:390` | routine et fil `for update of r, thread` (`:421`) → réservation d'ingress (`on conflict`, `:439`) → **abonnement** (`:450`) | aucun |
| 6 | `withTenant`, `persona-drafts.ts:31` | bot `for update of b` (`bot-activity.ts:120`) | aucun |
| 7 | `withTenant`, `bots.ts:216` | bot inséré dans la même transaction | aucun |
| 8, 9 | `db.begin`, `routines.ts:125` | routine `for update of r skip locked` (`:155`) → fil `for update` (`:165-168`) ; politique du bot lue **sans verrou** (`:126-146`) | aucun |
| 10, 11, 14, 15, 16 | transaction de `persistEvents`, `persist.ts:207` (ou de `reapPoisonRuns`, `queue.ts:512`) | run courant `for update` sous bail (`persist.ts:208-215`) → workflow `for update` (`lockWorkflowTx`, `permission-rule-sources.ts:61`) → curseur (`persist.ts:219`) ; 14 et 15 relisent le workflow `for update` (`workflows.ts:81`, `:283`). Le poison : runs `skip locked` → workflows → approbations (`queue.ts:512-541`) | notices sur le run **courant** (`appendNoticeTx`) ; aucun événement sur le run créé |
| 12, 13 | même transaction de `persistEvents` | roster `for key share of b` (`handoff.ts:131`), après le curseur | `system.notice` « Transmis à » sur le **courrier** (`handoff.ts:173`, `max+1` sous le curseur déjà pris) |

## 4. Les écritures de `workflows`

| Écriture | Accompagne | Statut | `initiator_user_id` | Budget |
|---|---|---|---|---|
| `conversation-message-routes.ts:418` | run 1 | `queued` | `auth.userId` | politique du bot du fil (DM) ou de l'orateur (salon), relue sous verrou ; `used_steps = 1` ; salon : `max_steps` = `ROOM_LIMITS.maxMemberTurns` (18) ; mention : au moins 2 étapes et 1 handoff (`:402-408`) |
| `message-version-routes.ts:319` | run 2 | `queued` | `auth.userId` | politique du bot racine ; mention : au moins 2 étapes et 1 handoff (`:313-314`) ; `plan_only`, `never_wait` du tour source |
| `webhooks/sql.ts:528` | run 3 | `queued` | `endpoint.createdByUserId` | politique du bot verrouillé ; salon : 18 étapes (`webhook-ingress-routes.ts:141`) |
| `workflow-routes.ts:375` | run 4 | `queued` | `auth.userId` | **copie** du workflow relancé |
| `routine-routes.ts:489` | run 5 | `queued` | `auth.userId` | politique du bot ou de l'orateur ; salon : 18 étapes (`:485`) |
| `routines.ts:296` | run 8 | `queued` | `routine.createdByUserId` | politique du bot lue sans verrou |
| `routines.ts:374` | run 9 | `queued` | `routine.createdByUserId` | politique de l'orateur ; 18 étapes (`:382`) |
| `0091_run_admission_envelope.sql:49` (trigger) | un run déjà existant qui passe en `unknown` | `unknown` | celui du run | `timeout_seconds` dérivé de `deadline_at - created_at`, borné à 60..3600 |

Les étapes 10, 14 et 15 ne créent pas de workflow : elles incrémentent `used_steps` (et
`used_handoffs`) du workflow verrouillé ; `workflows_used_steps_within_budget` refuse un
dépassement que `canDelegate` et `createWorkflowContinuationTx` (`workflows.ts:319`) doivent avoir écarté avant.

## 5. Allocation des séquences d'événements

Le curseur global (`run_events.cursor`, identité) est ordonné par le verrou consultatif de
l'organisation `openedbot-run-events-cursor`, que tout écrivain prend avant d'insérer
(`runner/events.ts:64-66`, gardé par `apps/api/tests/run-events-cursor-lock.test.ts`). La
`sequence` par run, elle, est calculée de quatre façons.

| Famille | Sites | Dans la transaction ? | Sérialisé ? |
|---|---|---|---|
| A. `max+1` dans une instruction **après** celle qui prend le curseur | `runner/events.ts:18-21` (`appendEventTx`, toutes les notices), `runner/handoff.ts:237-240`, `conversation-followup.ts:388-397`, `run-cancellation.ts:266-281`, `run-receipts.ts:109-116` | oui | **oui** (O) : le verrou est par organisation et tenu jusqu'au commit ; en `READ COMMITTED`, l'instruction suivante voit les lignes du détenteur précédent |
| B. `max+1` dans **la même instruction** que la prise du curseur (CTE `cursor_locks as materialized`) | `queue.ts:88-108` (transmission d'approbation incertaine), `runtime-direct.ts:87-106`, `runtime-links.ts:149-168` (runtime injoignable) | oui | **non** (O, sonde) : l'instruction attend le verrou avec l'instantané pris à son début ; elle recalcule la séquence d'un écrivain qui vient de valider, et `on conflict do nothing` jette l'événement en silence (défaut D2) |
| C. `max+1` **hors transaction**, puis `persistEvents` | `runner.ts:907-911` (graine du normaliseur Hermes), `runner.ts:1416-1419`, `provider-recovery.ts:346-350`, `provider-recovery.ts:544-547`, `runner/failure.ts:187-190`, `runner/reconcile.ts:20-31` | non | **non** : `persistEvents` prend ensuite le verrou du run (`persist.ts:208-215`) puis le curseur (`:219`) mais ne recalcule rien ; une collision est jetée par `on conflict do nothing` (`:251`) et `if (!row) continue` (`:263`) saute aussi la transition d'état portée par l'événement (défaut D3) |
| D. Séquence **en dur** sur un run créé dans la même transaction | `conversation-message-routes.ts:497`, `:503` (0 et 1), `message-version-routes.ts:353` (0) | oui | oui, parce que le run n'est visible de personne avant le commit |

Les séquences du normaliseur Hermes (famille C) avancent en mémoire à partir de la graine de
`runner.ts:907-911` ; elles ne sont sûres que parce que, tant qu'un bail est valide, seul son
porteur écrit sur le run (les écritures de l'API visent un run neuf, un run `queued` ou le
courrier ; les faucheurs écrivent après expiration et retirent le bail dans la même instruction).
C'est une convention, pas une garantie.

La sonde de la famille B (lancée en S2a, non gardée dans le dépôt) : une transaction prend le
curseur et insère la séquence 0 d'un run sans valider ; une seconde connexion lance la forme de
`runtime-direct.ts:87-106` et reste bloquée sur le verrou (`pg_locks` : 1 verrou consultatif non
accordé) ; au commit de la première, la seconde calcule encore `0`, son `on conflict do nothing`
n'insère rien, et le journal ne contient que la ligne de la première. S2c doit en faire un test.

**Depuis S2c** (section 9.2), les quatre familles passent par une seule primitive : plus aucun
`max+1` hors d'elle, ni dans l'instruction qui attend le verrou, ni hors transaction ; la famille D
n'a plus de valeur en dur (un run neuf reçoit 0 et 1 de l'allocation). Le test de la famille B est
`tests/integration/run-event-sequences.ts`, partie 2.

## 6. Le trigger 0091 et les runs en `unknown`

Le trigger 0091 donne un chemin de revue (workflow `unknown`, que `reconcile`, `abandon`, `retry`
et la boîte de réception savent traiter) à un DM racine sans workflow. Les sorties de `unknown`
sont indexées par workflow (`workflow-routes.ts:158`, `:208`, `:353`) ; l'arrêt d'un fil et
l'annulation d'un run refusent un run `unknown` (`conversation-routes.ts:186-194`,
`run-routes.ts:14-21`, `WORKFLOW_REVIEW_REQUIRED`). Seule exception : `cancelMaintenanceRunsTx`
(`run-cancellation.ts:274`) passe en `cancelled`, à l'archivage ou à la purge d'un bot
(`modules/roster/src/application/bots.ts:531`), un run `memory` ou `compaction` même `unknown` ;
ces types n'ont plus de producteur. Un autre run qui passe en `unknown` sans workflow et hors du
trigger n'a donc **aucune sortie** sans SQL manuel.

| Producteur | Peut finir en `unknown` ? | Couvert ? | Preuve |
|---|---|---|---|
| 1 avec workflow, 2, 3, 4, 5, 8, 9, 10, 14, 15 | oui | oui : chaque écrivain d'`unknown` met aussi le workflow en `unknown` | lecture (O) |
| 1 sans workflow (DM simple, repli de steer) et 7 (accueil) | oui | oui : racine, initiateur posé à l'admission | test, cas 2 (O) |
| DM racine **sans initiateur**, membre de l'organisation | non tant que l'organisation vit | — | test, cas 2 : `erase_account_user` pseudonymise un compte qui garde une ligne d'adhésion (`0171_deletion_and_blob_integrity.sql:64-96`) et aucune écriture ne supprime d'adhésion d'une organisation vivante (O) |
| **DM racine sans initiateur, opérateur d'agence** (pro) | **oui, rare** | **non** | lecture (O) : sous mandat d'agence, l'opérateur écrit chez un client sans y avoir d'adhésion (`apps/api/src/routes/identity/auth.ts:214`) ; s'il supprime son compte, la purge de ses propres organisations efface ses adhésions, `erase_account_user` supprime alors l'utilisateur (`0171…sql:79-81`) et la FK met à `null` l'initiateur de ses tours encore vivants chez le client. Un tel tour qui passe ensuite en `unknown` n'a pas de workflow (défaut D1) |
| Insertion **directe** en `unknown` | non en production | — | test, cas 1 : les 16 écritures posent `queued` ou `relaying` en littéral ; la base, elle, l'accepterait sans workflow (O) |
| 13 (courrier `relaying`) | non : jamais réclamé ; l'annulation le passe `cancelled` (`run-cancellation.ts:167-168`) | — | lecture (O) |
| **6 (brouillon de persona)** | **oui**, chemin actuel | **non** : `persona_draft`, sans initiateur, sans workflow | test, cas 3b (O) |
| **12 (run entrant d'un handoff)** | **oui**, données héritées seulement (3.1) | **non** : `step_kind` nul, sans initiateur, sans workflow | test, cas 3a (O), producteur appelé directement |
| 11, 16 (salon hérité) | oui en théorie | non | lecture ; producteurs morts (I) |

Écrivains qui posent `unknown` sans connaître le trigger : `queue.ts:73` (transmission
d'approbation incertaine), `queue.ts:274` (bail perdu pendant la création), `queue.ts:551`
(poison), `runner.ts:409`, `runner/failure.ts:82`, `runner/failure.ts:237`,
`apps/worker/src/infrastructure/worker-registry.ts:44` (arrêt pendant la création) et
`run-cancellation.ts:189`. Ce dernier est déclenché par l'opérateur : annuler un run pendant
qu'il crée son run Hermes (`creating`, sans id) suffit à le passer en `unknown`.

## 7. Transitions de `runs.status`, `external_state`, `remote_stop_state`

Graphe des statuts tel que le code l'écrit (créations comprises). « Actif » = `starting`,
`running` ou `awaiting_approval`. Huit écrivains mènent à `unknown` ; ses sorties passent par un
workflow, sauf l'annulation de maintenance des types morts `memory` / `compaction`.

```
   insert (15 écritures)
          |
          v
   +-----------+    claim    +------------+   create OK   +-----------+   gate    +---------------------+
   |  queued   | ----------> |  starting  | ------------> |  running  | <-------> |  awaiting_approval  |
   +-----------+             +------------+               +-----------+  réponse  +---------------------+
     |     ^                        |                           |                            |
     |     |                        +------------+--------------+----------------------------+
     |     |                                     |  depuis un état actif
     |     |                                     |
     |     +---- bail expiré, retry, arrêt ------+
     |                                           +----> completed | failed | cancelled
     |                                           |
     |                                           +----> unknown  (8 écrivains)
     |
     +----> cancelled  (annulation locale, steer)  ----> queued   (rejeu du steer)
     |                                             ----> unknown  (décision perdue, runner.ts:409)
     +----> failed     (échéance avant démarrage, runtime injoignable)
     |
     +----> unknown    (annulation incertaine, run-cancellation.ts:189)


   +-----------+   reconcile (workflow)            ----> queued
   |  unknown  |   abandon, retry (workflow)       ----> failed
   +-----------+   maintenance (memory, compaction) ----> cancelled


   insert (courrier) ----> relaying ----> completed (livraison) | cancelled (annulation)

   completed et failed sont finaux (trigger 0081) ; cancelled ne l'est pas.
```

### 7.1 Statut

« Bail » = l'écriture exige `lease_owner = workerId and lease_generation = <génération>`.

| Transition | Écriture | Garde | Bail |
|---|---|---|---|
| `queued` → `starting` (crée le bail, `lease_generation + 1`) | `queue.ts:445` | candidat `queued`, `for update of r, rt skip locked` (`queue.ts:418`), workflow revalidé (`:420-431`) | crée |
| `starting` → `running` (+ `hermes_run_id`, `creating` → `streaming`) | `runner.ts:860` | `status = 'starting' and external_state = 'creating'` | oui |
| actif → `running` (nouvel id Hermes après repli) | `runner.ts:1072` | `external_state = 'creating' and hermes_run_id is null` | oui |
| `starting` → `running` ou `awaiting_approval` (reprise d'un run connu) | `runner.ts:1367` | `status = 'starting'` | oui |
| `awaiting_approval` → `running` | `runner.ts:427` | `status = 'awaiting_approval'` | oui |
| actif → `awaiting_approval` | `persist.ts:340` | garde du `for update` initial (`persist.ts:208-215` : actif, arrêt non demandé) | oui |
| actif → `completed` (`settled`) | `persist.ts:360` | idem | oui |
| actif → `failed` (`settled`) | `persist.ts:498` | idem | oui |
| actif → `queued` (arrêt à retransmettre, `stopping`/`requested`) | `runner/cancel.ts:90` | actif | oui |
| actif → `cancelled` (`settled`, arrêt `confirmed`) | `runner/cancel.ts:237` | actif | oui |
| `queued` (non démarré) → `cancelled`, étapes sœurs | `runner/cancel.ts:282` | `queued and external_state = 'not_started'` | — |
| actif → `queued` (nouvel essai différé) | `runner/failure.ts:161` | actif | oui |
| actif → `unknown` (`markRunUnknown`) | `runner/failure.ts:82` | actif | oui |
| actif ou `unknown` → `unknown` (`HERMES_CREATE_COMMIT_LOST`) | `runner/failure.ts:237` | statut seulement | **non** (bail perdu par définition) |
| actif ou **`cancelled`** → `unknown` (décision transmise, confirmation perdue) | `runner.ts:409` | statut seulement (`:414-415`) ; l'époque de transmission (`:393-397`) garde la confirmation de la porte, dont l'échec mène justement ici | **non** |
| actif → `queued` (arrêt du worker) | `worker-registry.ts:38` | `lease_owner` (sans génération), actif, et `not_started` ou id Hermes connu (`:38-40`) ; `external_state` **inchangé** | partiel |
| actif → `unknown` (arrêt pendant la création) | `worker-registry.ts:44` | `lease_owner` seul, `creating` sans id | partiel |
| actif → `unknown` (transmission d'approbation expirée) | `queue.ts:73` | statut + bail de transmission de la porte expiré | **non** (retire le bail) |
| `starting`/`running` → `queued` (bail expiré) | `queue.ts:134` | bail expiré, `attempts < 5`, `not_started` ou id connu | — (faucheur) |
| `queued` → `failed` (échéance avant démarrage) | `queue.ts:176` | `queued and not_started`, workflow ou `deadline_at` échu | — |
| actif → `unknown` (bail perdu pendant la création) | `queue.ts:274` | bail expiré, pas d'id, `creating`/`streaming`/`stopping` | — (faucheur) |
| `awaiting_approval` → `queued` (bail expiré, id connu) | `queue.ts:289` | bail expiré, `attempts < 5` | — (faucheur) |
| actif → `unknown` (poison, issue incertaine) | `queue.ts:551` | `for update skip locked` (`:528`), tentatives épuisées | — (faucheur) |
| actif → `failed` (poison prouvé terminal) | `queue.ts:603` | même verrou, `not_started` ou `settled` | — (faucheur) |
| `queued` → `failed` (runtime injoignable) | `runtime-direct.ts:68`, `runtime-links.ts:130` | `queued`, sans id, plus vieux que le délai | — |
| `unknown` → `queued` (`polling`) | `workflow-routes.ts:158` (reconcile) | `unknown`, id Hermes connu, workflow `unknown` verrouillé | — |
| `unknown` → `failed` | `workflow-routes.ts:208` (abandon), `:353` (retry) | `workflow_id = X and status = 'unknown'` | — |
| `queued` → `failed` / `queued` (repli d'un steer ambigu) | `workflow-routes.ts:199`, `:286` | `queued` | — |
| `queued`, actif ou `relaying` → `cancelled` | `run-cancellation.ts:175` | lignes verrouillées (`:33-55`, `:70-98`), sûr localement | — |
| `queued` ou actif → `unknown` (annulation incertaine) | `run-cancellation.ts:189` | lignes verrouillées, ni sûr localement ni arrêtable par id | — |
| quelconque → `cancelled` (maintenance) | `run-cancellation.ts:274` | **aucune** (l'appelant fournit les runs ; 0081 refuse un run final) | — |
| `queued` → `cancelled` (`steered_into_active`) | `run-steering.ts:439` | `queued` | — |
| `cancelled` (`steered_into_active`) → `queued` | `run-steering.ts:892` | filtre `replayable` calculé sous verrou (`:860`), pas de prédicat dans l'`update` | — |
| `relaying` → `completed` (livraison) | `runner/handoff.ts:234` | courrier `for update` (`:196`), `status = 'relaying'` | — |
| `relaying` → `completed` (handoff annulé) | `conversation-followup.ts:385` | relu **sans verrou** (`:363-368`), `update` sans prédicat de statut | — |

### 7.2 `external_state` et `remote_stop_state` seuls

| Changement | Écriture | Bail |
|---|---|---|
| `not_started` → `creating` (avant le `POST /v1/runs`) | `provider-recovery.ts:225` | oui |
| → `creating`, id Hermes effacé (repli de fournisseur) | `runner.ts:1045` | oui |
| `polling` → `streaming` (rejeu annoncé) | `runner.ts:896` | oui |
| → `polling` | `runner.ts:1270`, `:1333` | oui (sans garde de statut) |
| → `stopping` + `requested` | `runner.ts:551`, `runner/cancel.ts:71` | oui |
| → `polling` + `confirmed` | `runner.ts:561`, `runner/cancel.ts:118` | oui |
| → `remote_stop_state = 'ambiguous'` | `runner.ts:582`, `runner/cancel.ts:103` | oui (sans garde de statut) |
| `queued` avec id → `stopping`/`polling` + `requested` (échéance du workflow) | `queue.ts:237` | — |
| → `stopping` + `requested` (annulation par l'opérateur) | `run-cancellation.ts:182` | — |

## 8. Défauts relevés

Classés par gravité. Aucun n'est corrigé en S2a : D1 demande un chemin de revue, donc une
décision de produit, et les autres relèvent de S2b à S2d.

### Élevé

**D1 — Run `unknown` orphelin, sans chemin de revue (O, test). Corrigé en S2b** par
`0175_review_path_for_every_unknown_run.sql` (section 9.1). Le trigger 0091 n'ouvre pas de
workflow à un run sans workflow qui n'est pas `root` ou n'a pas d'initiateur, et les sorties de
`unknown` passent par un workflow (section 6). Trois formes, quand l'un des huit écrivains de la
section 6 les passe en `unknown` :

- **brouillon de persona** (6), chemin actuel : `persona_draft`, ni workflow ni initiateur ;
- **DM racine d'un opérateur d'agence dont le compte a été supprimé** (pro, rare) : l'initiateur
  est remis à `null` par la FK alors que le tour vit encore (section 6) ;
- **run entrant d'un handoff par courrier** (12), données héritées d'avant 0091 seulement.

Le test `orphan-unknown-runs.ts` montre la première et la troisième avec leurs vrais producteurs
(le second appelé directement) et le vrai faucheur (`queue.ts:274`) ; la deuxième est déduite de
la lecture. Conséquences observées ou lues :

- le fil reste bloqué : arrêt du fil et annulation du run répondent `409
  WORKFLOW_REVIEW_REQUIRED`, aucun run suivant n'est réclamé (`queue.ts:364-391`) ;
- chaque orphelin occupe une place de capacité du runtime pour toujours (`queue.ts:401-403`
  compte `unknown`) : avec une capacité de 2, deux orphelins arrêtent toute l'organisation (test) ;
- un nouveau brouillon de persona est refusé `BOT_BUSY` (`bot-activity.ts:130-137`, test) ;
  l'archivage et la suppression du bot attendent (`modules/roster/src/sql/bots.ts:485`, `:506`,
  `modules/portability/src/application/host-profile-delete.ts:332`, `:348`) ;
- la demande de suppression du compte est enregistrée, mais la purge définitive de l'organisation
  n'est jamais réclamée (`modules/identity/src/sql/deletions.ts:191`, `:221`) ;
- pour un handoff, le courrier du fil d'origine reste `relaying` jusqu'à ce que l'opérateur arrête
  ce fil (test) ; la cible ne répond jamais ;
- l'avis du poison dit « abandonnez le workflow » avec `workflowId: null` (`queue.ts:585-595`).

Détection : pour l'exploitation, les métriques `run_status_counts`, `needs_review_runs` et
`oldest_unknown_seconds` (`metrics-routes.ts:76-82`), plus les avis et journaux du chemin qui a posé
`unknown` (par exemple `runner/failure.ts:103`) ; pour l'utilisateur, le fil affiche `needs_review`
(`conversation-thread-routes.ts:128`) sans action possible. Reprise : SQL manuel. Piste S2b : la primitive de transition vers `unknown` ouvre le chemin de revue pour **tout**
run sans workflow (ou le trigger 0091 est élargi dans la même migration), avec une revue qui sait
livrer le courrier d'un handoff abandonné.

### Moyen

**D2 — `max+1` sous un instantané périmé (O, test). Corrigé en S2c** (section 9.2). Les trois sites de la famille B (section 5)
prennent le curseur dans la même instruction que le calcul. En course avec un écrivain du même run
(un reçu `message.admitted` sur un run `queued` replié, par exemple), l'événement `run.error` est
perdu sans erreur : le run est `failed` en base mais le journal ne le dit pas, et un client en
direct ne voit pas l'échec avant de relire le fil.

**D3 — Séquences du worker allouées hors transaction, collisions jetées en silence (O, test).
Corrigé en S2c** (section 9.2). Six
sites (famille C) calculent `max+1` hors transaction. `persistEvents` insère avec `on conflict do
nothing` puis `continue` : une collision avec un **autre** événement fait sauter l'écriture de
`runs` qui l'accompagne (`completed`, `failed`, `awaiting_approval`). Aucune course n'est connue
aujourd'hui (seul le porteur du bail écrit, section 5), mais rien ne la refuse. Cible S2c.
*Constaté en S2c* : une course existait bien, dans le **même** lot. Le normaliseur numérote les
`tool.result.attached` d'un tour **après** son `run.completed` ; `persistEvents` traitait
`run.completed` (qui peut ajouter un avis : délégation hors plateforme, passe de salon, étape de
workflow) avant d'insérer la suite, et l'avis prenait la séquence du premier
`tool.result.attached`, perdu (test, partie 4). Le repli de fournisseur en avait déjà connu une
forme (« ello » pour « hello », 2026-10-24, contournée par `normalizer.skipPast`).

**D4 — Arrêt du worker : remise en file sans `polling` (I).** `worker-registry.ts:38` remet en
`queued` un run qui a un id Hermes en laissant `external_state` tel quel (`streaming`), alors que
le faucheur fait passer le même cas à `polling` et `events_complete = false` (`queue.ts:134-142`).
À la reprise, le chemin « rejeu non annoncé → réconciliation par lecture du statut »
(`runner.ts:885-890`) ne s'applique qu'à `polling`. Avec un rejeu annoncé, le flux reprend depuis
`last_hermes_sequence` (`runner.ts:937`, `:958`) ; **sans** rejeu annoncé, il se raccroche au flux
sans `since` au lieu de lire le statut. À confirmer par un test en S2d (ADR 0001, section 5, lignes « worker qui plante »).

### Faible

- **D5 — Ordre des verrous abonnement / fil inversé (I, pro).** L'envoi verrouille l'abonnement
  puis le fil (`conversation-message-routes.ts:106`, `:150`) ; le lancement manuel d'une routine
  (`routine-routes.ts:421`, `:450`) et le webhook (`webhooks/sql.ts:96`,
  `webhook-ingress-routes.ts:96`) verrouillent le fil puis l'abonnement. En solo `readForUpdate` ne verrouille
  rien (`platform/db/src/subscription-port.ts:67`) ; en pro il verrouille `subscriptions`
  (`openedbot-pro/packages/pro-billing/src/sql/subscriptions.ts:92`) : impasse détectée par
  PostgreSQL, une des deux requêtes échoue.
- **D6 — Courrier clos sans garde (`conversation-followup.ts:363-386`).** Lecture sans verrou,
  `update` sans `status = 'relaying'`. Sûr aujourd'hui parce que le run entrant est verrouillé
  avant (`run-cancellation.ts:33-55`, `:70-98`), donc sérialisé avec `deliverHandoffReplyTx`.
- **D7 — Branche morte du handoff.** `createHandoffTx` annonce `created: false` « si le fil de la
  cible est occupé » (`handoff.ts:138`) mais renvoie toujours `created: true` (`:178`) : l'avis
  « est occupé » de `persist.ts:453-461` ne part jamais.
- **D8 — Runs sans enveloppe d'admission.** 6, 11, 12, 16 (et 10 quand le run courant n'a pas de
  workflow, `rooms.ts:661-668`) n'ont ni workflow ni `deadline_at` : la
  file les laisse attendre sans plafond (`queue.ts:355`) ; avant leur démarrage, seule la panne du
  runtime les clôt automatiquement (`runtime-direct.ts:68`, `runtime-links.ts:130`) ; l'opérateur
  peut les annuler.
- **D9 — Run abandonné encore marqué à vérifier (I).** `abandon` et `retry` passent un run de
  `unknown` à `failed` sans toucher `external_state` ni `events_complete = false`
  (`workflow-routes.ts:208`, `:353`) : il reste dans `runs_reconciliation_idx`. Si son état externe
  était `ambiguous`, le fil le présente encore `needs_review` (`conversation-thread-routes.ts:128`) ;
  un run passé en `unknown` avec `polling` (`settleOrphanCreate`, `runner/failure.ts:237-239`) ne
  l'est plus. Peut-être voulu (risque de doublon) ; à trancher en S2d.
- **D10 — Politique de routine lue sans verrou.** `fireDueRoutine` (`routines.ts:126-146`) et le
  lancement manuel (`routine-routes.ts:398-421`, membres d'un salon à `:874`) lisent l'autonomie du
  bot sans verrouiller le bot, quand l'envoi la relit `for update` ; une modification
  concurrente de la politique peut être ignorée pour une occurrence.
- **D11 — Types morts.** `memory` et `compaction` (section 3.1) et les chaînages de salon hérités
  (11, 16).

## 9. Proposition pour S2b : commandes et primitives

Une commande par intention, chacune propriétaire de sa transaction, toutes construites sur des
primitives privées de `modules/execution`. Le garde S2b interdit toute autre écriture physique de
`runs` et `workflows`.

| Commande | Remplace | Particularités à garder |
|---|---|---|
| `admitUserTurn` | 1 (et sa partie `workflows`) | dispositions fold / enqueue / steer / supersede, workflow seulement si salon, mention ou autonomie, `deadline_at` et initiateur sur un DM simple, notices de mention, reçus |
| `branchTurn` | 2 | nouveau fil, préfixe copié, verrou de famille, workflow toujours |
| `admitWebhookDelivery` | 3 | idempotence par livraison, workflow toujours, initiateur = auteur du point d'entrée |
| `retryWorkflow` | 4 | ancien workflow et runs `unknown` → `failed`, copie du budget, `source_message_id` |
| `fireRoutine` (manuel, planifié ; bot, salon) | 5, 8, 9 | réservation d'ingress (manuel), `skip locked` et reports (planifié), `never_wait`, exécution consignée |
| `queuePersonaDraft`, `greetNewBot` | 6, 7 | runs de service ; chacun doit recevoir une enveloppe et un chemin de revue (D1, D8) |
| `startWorkflowStep` (délégation, reprise, tour de salon) | 10, 14, 15 | budget du workflow verrouillé, `step_index`, `stack_depth`, appelant |
| *(à retirer)* | 11, 16 ; 12 + 13 | après comptage en prod des runs de salon sans `group_state` et des DM sans `step_kind` encore vivants ; d'ici là, l'entrant d'un handoff doit recevoir un chemin de revue (D1) |

Primitives partagées :

- **`lockAdmissionTx`** : un ordre unique abonnement → fil → run concerné → workflow → bots →
  curseur, qui corrige D5 ;
- **`insertRunTx(kind, …)`** : seule écriture de `runs`, typée par genre (DM simple, étape de
  workflow, service, handoff) ; elle impose statut `queued` (ou `relaying` pour un courrier), la
  cohérence `step_kind` / workflow / appelant, l'initiateur et `deadline_at` pour un run sans
  workflow, la propagation de `plan_only` ;
- **`openWorkflowTx`** : seule écriture de `workflows`, avec son run racine dans la même
  transaction (FK différée), budget figé depuis une politique lue sous verrou (D10) ;
- **`appendRunEventsTx`** (S2c) : verrou du run, puis curseur, puis `max+1` dans une instruction
  séparée, dans la transaction qui insère ; un mode « run neuf » pour les séquences de la famille
  D ; plus de `on conflict do nothing` silencieux hors rejeu Hermes (D2, D3) ;
- **`transitionRun`** (S2d) : table des transitions de la section 7, fencing par bail obligatoire
  pour le worker, et passage en `unknown` qui garantit un chemin de revue (D1).

### 9.1 Réalisé en S2b (2026-11-06)

Les 16 créations passent par des commandes de `modules/execution`, chacune dans la transaction de
son appelant, qui garde ses verrous, leur ordre et ses événements (aucun n'est déplacé : D5 et D10
restent ouverts). Les commandes ne verrouillent rien et ne lisent aucune politique : l'appelant
leur passe le budget qu'il a figé.

| # | Commande | Fichier |
|---|---|---|
| 1 | `admitUserTurnTx` (DM simple, repli de steer, salon, mention, remplacement) | `application/run-creation.ts` |
| 2 | `branchTurnTx` | idem |
| 3 | `admitWebhookDeliveryTx` | idem |
| 4 | `openWorkflowRetryTx` (moitié création ; l'ancien workflow et ses runs `unknown` restent réglés par la route, S2d) | idem |
| 5, 8, 9 | `fireRoutineTx` (`manual` / `scheduled`, bot / salon) | idem |
| 6 | `queuePersonaDraftRunTx` | idem |
| 7 | `greetNewBotTx` (le délai d'autonomie est lu avant l'insertion, dans la même transaction, au lieu d'une sous-requête) | idem |
| 10, 14, 15 | `startWorkflowStepTx` (`group`, `delegated`, `continuation`) | `application/runner/workflow-steps.ts` |
| 10 sans workflow, 11, 16 | `chainLegacyRoomTurnTx` | idem |
| 12, 13 | `openHandoffTx` | idem |

Primitives privées (`sql/run-writes.ts`), seules écritures physiques de création :
`insertRunTx` (tout run), `openWorkflowTx` (workflow puis son run racine, `used_steps = 1`,
`deadline_at = now() + timeout`), `claimWorkflowStepTx` (`used_steps + 1`, `used_handoffs + 1` pour
une délégation, `status = 'running'`). Chaque instruction énumère toutes ses colonnes, valeurs par
défaut de la table comprises ; une forme invalide est refusée avant d'écrire
(`domain/run-creation.ts`, `newRunViolation`, `newWorkflowViolation`) : statut `queued` ou
`relaying`, courrier sans bot ni workflow, étape de workflow avec index et genre de tour, pas de
`deadline_at` sur une étape de workflow, `delegated` avec appelant, run de service hors workflow,
salon à 18 étapes, racine déléguée ⇔ un handoff consommé. Ce sont des erreurs de programmation, pas
des erreurs de domaine : aucune n'atteint un client.

Seul changement d'ordre : la délégation (14) écrit le `completion_kind` du run courant avant
d'insérer l'enfant, au lieu d'après ; aucune garde ni trigger ne lit cette colonne.

**Garde.** `tests/scripts/run-writes-contract.ts` (`make test-unit`, testé par mutation dans
`run-writes-contract.test.ts`), plus la règle dependency-cruiser `primitives-de-creation-privees`
(`make deps-check`) :

- strict : `insert into runs`, `insert into workflows`, `delete from runs|workflows` et le compte
  d'étapes d'un workflow (`update workflows` qui pose `used_steps` ou `used_handoffs`) n'existent que
  dans `sql/run-writes.ts` ; dans `db/migrations`, seul le trigger de revue (0091, 0175) insère un
  workflow ; seules les deux commandes importent les primitives ;
- cliquet daté (S2d, jusqu'au 2026-12-31, `tests/scripts/run-writes-debt.json`) : les autres
  `update runs` (66) et `update workflows` (36) sont comptés par fichier ; un compte peut baisser
  (`--record`), jamais monter, et un fichier absent du cliquet ne peut pas se mettre à écrire. Ces
  instructions sont les transitions de la section 7 et les colonnes qui voyagent avec elles
  (`completion_kind`, `output`, `last_hermes_sequence`, `used_tokens`…) : S2d doit trier ce qui
  rejoint la fonction de transition et ce qui reste une écriture de colonne.

**D1.** `0175_review_path_for_every_unknown_run.sql` remplace la fonction et le trigger de 0091 :
tout run sans workflow qui **passe** en `unknown` reçoit son workflow de revue (`group` dans un fil
de salon, `dm` sinon, initiateur du run, éventuellement nul), comme le DM racine auparavant.
Brouillon de persona, run entrant d'un handoff, tour de salon hérité et DM sans initiateur
s'abandonnent donc depuis la boîte de réception, ce qui libère le fil, la place de capacité et le
bot (test d'intégration). Deux ajustements de la revue l'accompagnent : la relance est refusée pour un run de
service (`409 WORKFLOW_SERVICE_RETRY_UNSUPPORTED`, le brouillon se relance depuis la fiche du bot)
et pour le run entrant d'un handoff hérité (`409 WORKFLOW_HANDOFF_RETRY_UNSUPPORTED` : la copie
n'aurait plus de courrier à qui livrer), celle d'un salon l'étant déjà ; et un run de service ou un
tour de salon hérité réconcilié, qu'aucune étape de workflow ne règle, clôt sa revue
(`settleReviewWorkflowTx`, `completed` ou `failed`, au lieu de la laisser `running`). Le cliquet de
`runner/workflows.ts` passe de 5 à 6 `update workflows` pour cette transition.

Reste ouvert :

- ~~**S2c**~~ : fait (section 9.2) ;
- **S2d** : fonction de transition et vidage du cliquet ; D4, D6, D9 ; l'ancien workflow d'une
  relance réglé par la route ;
- un abandon de la revue d'un run entrant ne livre pas son courrier : le fil d'origine reste
  `relaying` jusqu'à son arrêt par l'opérateur (inchangé, données héritées seulement) ;
- D5 (ordre des verrous abonnement / fil) et D10 (politique de routine lue sans verrou), qui
  demandent de déplacer des verrous de route ; D7 ; D8 (runs sans enveloppe : 6, 11, 12, 16) ;
- retrait de 11, 12, 13, 16 après comptage en production.

### 9.2 Réalisé en S2c (2026-11-06)

**Primitive.** `modules/execution/src/sql/run-events.ts`, seul écrivain de `run_events` (règles
pures dans `domain/run-event-sequence.ts`). Dans la transaction de l'appelant, elle prend, dans cet
ordre : la ligne de chaque run visé (`for no key update`, par organisation puis id), le verrou du
curseur de chaque organisation (ordre des organisations), puis lit `max(sequence)` dans une
instruction distincte, et insère sans `on conflict`.

| Fonction | Pour | Règle |
|---|---|---|
| `appendRunEventsTx(tx, drafts)` | tout écrivain sauf le flux du worker | numérote après le dernier événement de chaque run, séquences contiguës ; un lot peut viser plusieurs runs et organisations : toutes les lignes avant tout curseur |
| `appendNumberedRunEventsTx(tx, cible, événements)` | le flux du worker (`persistEvents`) : séquences du normaliseur, déjà publiées avant le commit | mêmes verrous, puis contrôle : chaque séquence au moins égale à la prochaine libre et strictement croissante (trous permis : un tour de salon muet saute ses deltas) ; sinon `RunEventSequenceConflictError` (`RUN_EVENT_SEQUENCE_CONFLICT`) avant toute écriture |
| `lockRunEventsTx(tx, cibles)` | un écrivain qui doit prendre d'autres verrous avant d'écrire | les deux premiers verrous seuls, réentrants. `persistEvents` l'appelle juste après le verrou du workflow : le curseur garde sa place, **avant** les `for share` des portes (organisation, bot). Le prendre après eux ouvrirait une impasse avec la purge d'un bot, qui tient le curseur puis écrit `bots` |
| `readNextRunEventSequence(db, org, run)` | la graine du normaliseur (`runner.ts`) | une proposition, hors transaction, revérifiée par `appendNumberedRunEventsTx` à chaque écriture |

`for no key update` plutôt que `for update` : ce verrou sérialise les écrivains d'un run entre eux
et avec tout `update runs`, sans entrer en conflit avec le `for key share` qu'une clé étrangère
(message, approbation, événement) prend sur la même ligne. Les reçus prenaient `for key share`,
qui ne sérialisait rien avec la famille B (D2) ; un `for update` aurait en plus créé une impasse de
montée de verrou entre deux transactions ayant chacune inséré une ligne qui référence le run. Le
`for update` du bail de `persistEvents` (`fence`) reste, la primitive le reprend sans attendre.

**Sites migrés** (les 14 calculs de la section 1, recomptés : 14, plus l'insertion du flux) :

| Famille | Site | Après S2c |
|---|---|---|
| A | `runner/events.ts` `appendEventTx` (toutes les notices) | `appendRunEventsTx` |
| A | `runner/handoff.ts` `deliverHandoffReplyTx` | `appendRunEventsTx` (courrier, après son `for update`) |
| A | `conversation-followup.ts` `settleCancelledHandoffsTx` | `appendRunEventsTx`, après l'`update` du courrier |
| A | `run-cancellation.ts` `cancelMaintenanceRunsTx` | les `update runs` d'abord, puis une seule `appendRunEventsTx` ; le curseur n'est plus pris avant les lignes |
| A | `run-receipts.ts` `flushRunJournalTx` | une seule `appendRunEventsTx` pour toutes les organisations (`for key share` remplacé par le verrou de la primitive) |
| B | `queue.ts` `reapExpiredApprovalSends`, `runtime-direct.ts` `failRunsOnUnhealthyDirectRuntimes`, `runtime-links.ts` `failRunsOnDisconnectedRuntimes` | la CTE rend les runs réglés, la primitive numérote leurs `run.error` dans une seconde instruction de la même transaction (D2). Le troisième vit désormais dans `modules/execution/src/application/disconnected-runtime-runs.ts` : `runtime-link` ne peut pas importer `execution` (cycle par `runtimes`), et n'écrit plus ni `runs`, ni `workflows`, ni `run_events` (`db/ownership.json`) |
| C | `runner.ts` graine du normaliseur ; `reconcile.ts`, lot réconcilié terminé (texte + `run.completed`) | `readNextRunEventSequence` (proposition), puis `persistEvents` : le texte retrouvé part avant le commit comme un delta, sa séquence est revérifiée sous les verrous (`run-crash-replay.ts` le garde) |
| C | `runner.ts` `completeGroupTurnWithoutHermes`, `provider-recovery.ts` (repli, absence de fournisseur), `failure.ts` `handleFailure`, `reconcile.ts` (échec réconcilié) | `persistUnnumberedEvents` : même transaction que `persistEvents`, numérotation par `appendRunEventsTx` sous ses verrous ; aucun de ces événements n'était publié avant le commit. Le repli rend la séquence obtenue (nulle si le bail a été perdu) au normaliseur (`skipPast`) |
| — | `persist.ts` insertion du flux | `appendNumberedRunEventsTx` ; le lot entier est écrit **avant** ses effets (portes, transitions, avis), qui gardent leur ordre : un avis ajouté par `run.completed` vient après le lot (D3) |
| D | `conversation-message-routes.ts` (0 et 1), `message-version-routes.ts` (0) | `appendRunEventsTx` : le run est neuf, il reçoit 0 et 1 comme avant, sans valeur en dur |

**Comportement.** Identique par ailleurs, à trois détails près : un avis d'une complétion vient
après tout le lot qui la porte (avant, il prenait la place d'un `tool.result.attached`, perdu) ;
l'horodatage par défaut d'une allocation sans date est `clock_timestamp()` (celui des reçus) au lieu
de `now()` pour les balayages et la famille D ; une collision d'un lot numéroté est une erreur
nommée qui fait échouer le run par le chemin d'échec, lequel journalise son `run.error` (test,
partie 3). Le golden `apps/worker/tests/fixtures/unattended-golden.json` ne change que par le texte
de l'insertion : ses 2 400 cas gardent leurs écritures et leurs journaux.

**Garde.** `tests/scripts/run-events-contract.ts` (`make test-unit`, testé par mutation dans
`run-events-contract.test.ts`), strict, sur le code livré (`apps/*/src`, `modules/*/src`,
`platform/*/src`, `scripts/`) : hors de la primitive, ni `insert into run_events`, ni
`update run_events`, ni `max(sequence)` (aliasé ou non) dans une instruction qui lit `run_events`,
ni la clé du curseur ; dans `db/migrations`, aucune insertion, et seul le rattrapage d'identité de
0092 met la table à jour. Hors périmètre, justifié : `delete from run_events` (la purge de
rétention ne numérote rien) et les tests (leurs fixtures écrivent la table directement). Joué sur
les sites d'avant S2c, il relève les 14 calculs, les 12 insertions et les 9 prises du curseur.

**Tests.** `tests/integration/run-event-sequences.ts`, connexions séparées sur une base jetable :
(1) quatre producteurs de notices, deux d'API (reçus) et deux lots sur deux runs, en même temps,
pendant qu'un lecteur suit le curseur : séquences uniques et contiguës, ordre des curseurs égal à
celui des séquences, aucun événement sauté par le lecteur ; (2) D2 : un balayage du runtime direct
contre un écrivain qui tient un événement non validé du même run ; (3) D3 : une écriture numérotée
dont la séquence est prise est refusée, puis le chemin d'échec journalise le `run.error` ; (4) D3
tel qu'il arrivait : complétion + avis + `tool.result.attached`. Sur `develop` d'avant S2c, les
parties 2, 3 et 4 échouent (`run.error` perdu ; collision avalée, run resté `running` ;
`tool.result.attached` perdu) ; la partie 1 passait déjà (famille A sérialisée par le curseur) et
garde le nouvel ordre des verrous.

Reste ouvert :

- deux prises de verrou de run **après** le curseur subsistent, antérieures à S2c :
  `deliverHandoffReplyTx` verrouille le courrier dans la transaction de `persistEvents` (données
  héritées seulement, section 3.1), et le vidage d'un journal de reçus peut viser un run après un
  avis écrit plus tôt dans la même transaction. Une impasse y serait détectée par PostgreSQL (une
  transaction échoue), jamais silencieuse ;
- la graine du normaliseur et celle du lot réconcilié restent des lectures hors transaction : des
  propositions, imposées par la publication avant le commit, désormais contrôlées à chaque
  écriture ;
- S2d : fonction de transition et vidage du cliquet de S2b ; D4 à D11 inchangés.

## 10. Ce qui reste incertain

- D4, D5, D9 et la forme « agence » de D1 sont déduits de la lecture ; D1 (persona, handoff
  hérité) est prouvé par le test, D2 et D3 par `run-event-sequences.ts` (S2c).
- Le nombre de runs hérités (salon 11, 16 ; DM sans `step_kind` qui mènent au handoff 12, 13) et de
  runs `unknown` sans workflow en production n'est pas compté.
- Le comportement d'un client devant un run `needs_review` sans workflow n'a pas été regardé dans
  la console.
- Les écritures de `openedbot-pro` passent par les routes du cœur ; seul son code de production a
  été cherché (`insert into runs` n'apparaît que dans ses tests).

## Historique de revue
- 2026-11-06 : inventaire S2a, test `orphan-unknown-runs.ts`, sonde de la famille B.
- 2026-11-06, relecture Codex n° 1 : handoff par courrier reclassé en données héritées ; DM racine
  sans initiateur possible sous mandat d'agence (D1) ; sortie de maintenance de `unknown` ;
  conditions de `pg_notify` (0095) ; portée de la FK différée ; verrous de l'envoi (`supersede`,
  reçus) ; `step_kind` du retry ; purge (et non demande) bloquée ; détection ; D4 conditionné au
  rejeu non annoncé ; D5 et D10 étendus aux webhooks et routines manuelles. Revue de branche : le
  test découvre désormais tous les fichiers sources au lieu d'une liste fixe.
- 2026-11-06, relecture Codex n° 2 : passage en `unknown` de `runner.ts:409` non gardé par
  l'époque ; verrous de l'envoi avec mention (fil cible) et des reçus ; budgets imposés (salon à 18
  étapes, mention à 2 étapes et 1 handoff) ; garde de `worker-registry.ts:38` ; route publique du
  webhook ; D8 étendu à 10 ; D9 conditionné à l'état externe ; graphe complété
  (`queued` → `unknown`, `unknown` → `cancelled`). Revue de branche : aucune régression.
- 2026-11-06, S2b : commandes et primitives de création (section 9.1), garde
  `run-writes-contract.ts`, D1 corrigé par 0175.
- 2026-11-06, S2c : primitive d'allocation des événements (section 9.2), garde
  `run-events-contract.ts`, test concurrent `run-event-sequences.ts` ; D2 et D3 corrigés.
