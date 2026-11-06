# modules/

Un paquet par contexte métier (`identity`, `billing`, `runtimes`,
`runtime-link`, `roster`, `conversation`, `execution`, `portability`,
`notifications`, `support`, `staff`), nommé `@openedbot/<contexte>`.
Les métriques d'affaires (lecture de `workspace_business_metrics`) vivent dans
`runtimes` (`application/business-metrics`), leur consommateur : plus de
module `analytics`, ni tracker d'événements ni rollups.

Chaque module range son code sous `src/domain`, `src/application` et
`src/sql`, et ses tests sous `tests/`. Il importe `platform/`, `contracts/` et
les autres modules par leur nom de paquet ; jamais une application, jamais
`hono`. Ces règles sont tenues par `.dependency-cruiser.cjs`
(`make deps-check`).

Les `exports` du paquet sont des jokers de couche, pas une liste de fichiers :

```json
{
  "exports": {
    "./application/*": "./src/application/*.ts",
    "./domain/*": "./src/domain/*.ts"
  }
}
```

`src/sql` n'est pas publié (ADR 0001 S4) : un autre paquet, une application
ou un plug-in passe par la couche `application`, qui réexporte ce qu'elle
ouvre (`export { … } from "../sql/…"`, un fichier de façade au nom du fichier
SQL quand aucun cas d'usage ne le porte déjà). Un module n'importe que les
modules que déclare son `package.json`, et ce graphe reste sans cycle
(`module-par-ses-dependances`, `sql-prive-au-module`,
`tests/scripts/workspace-deps-contract.ts`).

Un fichier nouveau sous `src/domain/foo.ts` s'importe tout de suite en
`@openedbot/<contexte>/domain/foo`. Un `*` ne traverse pas un slash : un
sous-dossier (`domain/email/`, `domain/runtime/`) a sa propre clé. Ne pas
aplatir (`./email-address`) : ça masque la couche et force à retoucher
`package.json` à chaque fichier.
