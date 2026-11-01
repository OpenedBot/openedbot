/**
 * Le laboratoire de scénarios du header. Il ouvre une boîte contrôlée qui
 * propose plusieurs demandes reproductibles (approval, ask_user, plan et
 * réponse standard) au lieu d'envoyer immédiatement une commande au clic.
 *
 * Développement seulement : ce bouton écrit un message dans un vrai fil et
 * consomme un vrai run : il n'a rien à faire dans un build de production.
 * `=== true` parce que Bun mappe
 * `import.meta.env` sur `process.env` (des chaînes) là où Vite injecte un
 * booléen : un `DEV=1` d'environnement ne doit pas ouvrir le bouton.
 *
 * CE QUE LE SCÉNARIO D'AUTORISATION NE GARANTIT PAS : openedbot n'administre pas le runtime
 * d'un client (`CLAUDE.md`), donc il ne décide pas non plus ce qui est soumis
 * à approbation, c'est Hermes qui émet `approval.request` selon SA politique.
 * Le texte envoyé (`featureLab.approvalPrompt`) vise `execute_code`, la
 * primitive que le runtime connector prouve explicitement à travers la file
 * d'approbation run-scoped. Le programme est inoffensif : un unique `print`,
 * sans écriture ni réseau. Si aucune gate ne se lève, c'est le verdict : le
 * runtime connecté n'applique pas le contrat d'approbation annoncé.
 */
export const SHOW_FEATURE_LAB = import.meta.env.DEV === true;
