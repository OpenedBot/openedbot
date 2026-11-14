# Recette MVP avec mcp-app-desktop

Le lab utilise une base PostgreSQL unique et jetable, l’API réelle sur 8795, Mailpit et des transitions de workflow déterministes. Il ne contacte ni hôte Hermes de production ni fournisseur de modèle. Les identifiants et le profil desktop habituels ne sont pas utilisés.

## Préparer le lab

Depuis la racine, lancer `bun tests/e2e/mvp-desktop-lab.ts`. PostgreSQL et Mailpit doivent déjà tourner dans l’infrastructure de développement. Le script écrit les métadonnées non secrètes dans `tmp/e2e-desktop-mvp/fixture.json` et les journaux dans le même dossier. Ne jamais afficher une URL de base avec ses identifiants.

Lancer ensuite avec le tool MCP `launch` :

- `command`: `["bun", "run", "dev"]`, `framework`: `tauri`.
- `cwd`: chemin absolu de `apps/desktop-tauri`.
- `env`: `OPENEDBOT_DESKTOP_MCP=1`, `OPENEDBOT_DESKTOP_TEST_IDENTIFIER=app.openedbot.desktop.${MCP_APP_DESKTOP_PROFILE_ID}`, `DESKTOP_DEV_PORT=1432`, `API_PORT=8795`, `API_INTERNAL_URL=http://127.0.0.1:8795`.

Le pont est une dépendance Cargo optionnelle, épinglée à un commit ; son enregistrement est réservé aux builds debug avec `desktop-mcp`. Les builds distribués ne l’activent pas. Ne pas attacher le pilote au profil personnel.

## Parcours

1. Se connecter avec l’adresse du compte jetable et le code reçu dans Mailpit. Attendre le nouvel e-mail de cette tentative, pas celui d’une tentative antérieure. Le champ OTP natif est transparent : le cibler avec `click(hover_first: true)`, puis `type`. Le code se valide automatiquement.
2. Vérifier que l’accueil affiche la création de bot sans guide de démarrage. Le bot préparé par la fixture est prêt ; aucune machine n’est reliée, ce qui permet de vérifier le diagnostic sans provoquer d’action réelle.
3. Ouvrir Réglages puis exécuter `notifications.yaml` avec `run_flow`. Vérifier que les trois options sont désactivées initialement et qu’activer Mission terminée ne modifie pas les deux autres. Recharger et vérifier la persistance.
4. Arrêter l’application avec `stop(keep_artifacts: true)`, puis appeler `POST http://127.0.0.1:8796/complete`. Vérifier dans Mailpit un e-mail de fin pour le compte jetable. Relancer l’application et se reconnecter ; les préférences sont conservées côté serveur.
5. Ouvrir la conversation du bot et exécuter `files.yaml`. Inspecter les téléchargements réellement produits avec `bun tests/e2e/desktop-mvp/check-downloads.ts` : Markdown, JSON versionné et `rapport-mvp.txt`. Le JSON ne contient aucune colonne de secret. Vérifier le contenu et le SHA-256 du fichier témoin.
6. Vérifier recherche vide puis recherche par nom, aperçu et retour au message d’origine. Tester clair/sombre et tailles 13/14 dans Apparence. Conserver snapshots et captures.
7. Dans un navigateur avec un profil de recette, enregistrer une vidéo et trois rafraîchissements à chaque taille. Inspecter les captures initiales, React et chargées, ainsi que les images extraites de la vidéo ; des coordonnées finales identiques ne suffisent pas.

Une WKWebView occultée suspend ses frames et l’horloge des transitions CSS. Le flow fichiers attend la transition logique puis termine les animations finies pour vérifier l’état final. Cette accommodation est limitée au pilote ; elle ne valide pas la fluidité native. La vidéo navigateur couvre séparément les transitions réellement jouées.

## Contrôles automatiques

- `bun tests/integration/mvp-workflows.ts` : migration, défauts, isolation, validation, exclusion des salutations, progression, envoi durable, reprise SMTP, révocation, déduplication, fichiers et exports.
- `bun tests/integration/mvp-recovery.ts` : dump/restauration PostgreSQL dans une base neuve et fichier témoin vérifié par SHA-256.
- `make typecheck`, `make deps-check`, `make test-unit`, `make test-integration`, `make e2e-console`, `make desktop-tauri-check`.

La restauration complète d’Hermes, de R2 et des clés, ainsi que les parcours avec un vrai modèle et un vrai hôte, exigent un lab supplémentaire. Les marquer NON EXÉCUTÉS tant qu’ils n’ont pas de preuve ; cette recette locale ne vaut pas autorisation de publication.

## Nettoyage

Arrêter uniquement la session MCP de recette. Appeler `POST http://127.0.0.1:8796/stop` : le script arrête son API, supprime ses blobs et ferme/supprime sa base jetable. Copier les captures et téléchargements utiles dans le dossier de preuves avant de retirer les fichiers de test des Téléchargements. Ne pas supprimer les autres sessions MCP, les autres bases ni les autres messages Mailpit.

## Ordre de mise en service

Appliquer la migration `0189_mvp_workflow_preferences`, démarrer le worker mis à jour, puis l’API et la console. Les préférences restent désactivées tant que l’utilisateur ne les active pas. Mettre le worker à jour avant d’exposer ces interrupteurs évite qu’un ancien rendu d’e-mails reçoive les nouveaux genres. Aucune publication n’est effectuée par cette recette.
