# browser/

Code exclusivement navigateur, un paquet par sujet (`api-client`, `ui-kit`,
`i18n`, `face`), nommé `@openedbot/browser-<nom>`.

Un paquet de cette couche n'importe ni `platform/`, ni les dossiers
`src/application` et `src/sql` d'un module, ni un paquet serveur, ni `node:*`.
Ces règles sont tenues par `.dependency-cruiser.cjs` (`make deps-check`).
