/**
 * Nom produit dans l'onglet. Le serveur Vite de développement utilise le
 * libellé "openedbot (dev)" pour qu'un onglet local reste distinguable de la
 * production. Le ternaire vit à l'appelant : `vite.config.ts` tourne dans
 * Node, où `import.meta.env.DEV` n'est pas le booléen de Vite, et Bun
 * mappe `import.meta.env` sur `process.env` (des chaînes).
 */
export const PRODUCTION_APP_NAME = "openedbot";
export const DEVELOPMENT_APP_NAME = "openedbot (dev)";
