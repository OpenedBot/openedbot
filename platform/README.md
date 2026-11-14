# platform/

Socle technique des serveurs, un paquet par brique (`db`, `config`,
`observability`, `hermes`, `integrations`). `platform/hermes` garde son nom
`@openedbot/hermes` ; les autres s'appellent `@openedbot/platform-<nom>`.

La plateforme n'importe ni `apps/`, ni `modules/`, ni `browser/`. Ces règles
sont tenues par `.dependency-cruiser.cjs` (`make deps-check`).
