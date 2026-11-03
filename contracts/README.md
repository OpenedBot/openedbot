# contracts/

Couche des contrats : un paquet par contrat (`api`, `events`, `errors`,
`locale`, `i18n`, `connector`, `primitives`), nommé `@openedbot/contracts-<nom>`.

Un contrat est pur : aucune I/O, aucun `node:*`, et `zod` pour seule
dépendance externe. Il n'importe aucune autre couche du dépôt. Ces règles
sont tenues par `.dependency-cruiser.cjs` (`make deps-check`).

## `contracts/api` : un dossier par domaine

`contracts/api/src/` range les DTO par domaine métier, comme `modules/` :
`identity/`, `roster/`, `runtimes/`, `execution/`, `conversation/`,
`permissions/`, `notifications/`, `portability/`, `support/`, `inbox/`,
`billing/`, `agency/`, `a2a/`, `webhooks/`, `overview/`, et `shared/` pour les
types de base que tous citent (visage d'un bot, contenu d'un message, santé).

- Chaque dossier a un `index.ts` qui réexporte ses fichiers ; `src/index.ts`
  réexporte tous les dossiers. `@openedbot/contracts-api` sert tout, et
  `@openedbot/contracts-api/<domaine>` un seul domaine.
- Les domaines forment un graphe sans cycle, types seuls compris, et
  `shared/` n'importe aucun domaine (`tests/scripts/code-structure-contract.ts`,
  règle `contrat-api-sans-cycle` de `.dependency-cruiser.cjs`).
- L'API publique est figée par `contracts/api/tests/public-exports.test.ts` :
  un ajout ou un retrait voulu se constate avec
  `UPDATE_PUBLIC_EXPORTS=1 bun test contracts/api/tests/public-exports.test.ts`.
- Un fichier de `src/` ne dépasse pas 600 lignes (même contrat de structure,
  pour tout le dépôt ; la dette existante est plafonnée dans
  `tests/scripts/code-size-debt.json` et ne peut que baisser).
