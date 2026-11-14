/**
 * Product name in the tab. The Vite development server uses the
 * label "openedbot (dev)" so that a local tab stays distinguishable from
 * production. The ternary lives at the caller: `vite.config.ts` runs in
 * Node, where `import.meta.env.DEV` is not Vite's boolean, and Bun
 * maps `import.meta.env` onto `process.env` (strings).
 */
export const PRODUCTION_APP_NAME = "openedbot";
export const DEVELOPMENT_APP_NAME = "openedbot (dev)";
