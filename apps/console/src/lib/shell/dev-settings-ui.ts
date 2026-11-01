/**
 * Le groupe « Développement » de `/settings` n'est exposé que sous le serveur
 * Vite de développement (`make dev`). Un build de production / `preview-console`
 * ne le monte pas : Facturation n'est pas encore un produit (le paywall est un
 * chantier) et les outils de dev n'ont rien à faire devant un opérateur.
 *
 * `=== true` : Bun mappe `import.meta.env` sur `process.env` (des chaînes),
 * alors que Vite injecte un booléen. Une variable d'environnement `DEV=1`
 * ne doit pas ouvrir la nav.
 */
export const SHOW_DEV_SETTINGS = import.meta.env.DEV === true;
