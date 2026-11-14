/**
 * The « Développement » group of `/settings` is exposed only under the
 * Vite development server (`make dev`). A production / `preview-console` build
 * does not mount it: Billing is not a product yet (the paywall is a
 * work in progress) and the dev tools have no business in front of an operator.
 *
 * `=== true`: Bun maps `import.meta.env` onto `process.env` (strings),
 * whereas Vite injects a boolean. An environment variable `DEV=1`
 * must not open the nav.
 */
export const SHOW_DEV_SETTINGS = import.meta.env.DEV === true;
