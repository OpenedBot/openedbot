import { defineConfig, loadEnv } from "vite";
import { configureSseProxy } from "./vite-api-proxy";
import { buildId } from "./vite-build-id";
import { contentSecurityPolicy } from "./vite-csp";
import { localePreload } from "./vite-locale-preload";
import { CONSOLE_HOST_DIR, CONSOLE_HOST_PREFIX, proConsole, proConsoleEntries } from "./vite-pro-console";
import { moduleReport } from "./vite-module-report";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
// Chemin relatif, pas `@openedbot/platform-config/...` : Vite charge sa config en la groupant
// avec esbuild, qui suit les imports relatifs mais laisse les specifiers de
// paquet externes : Node échoue alors sur l'import sans extension du module
// partagé. Le relatif embarque toute la chaîne dans la config.
import { apiProxyTarget, clientPort, loadClientEnv } from "../../platform/config/src/client-env";
import { DEVELOPMENT_APP_NAME, PRODUCTION_APP_NAME } from "./src/lib/shell/app-name";

// Ni l'origine de l'API ni le port ne sont écrits ici : `API_PORT` et
// `WEB_APP_URL` les portent déjà, et un littéral ne pourrait que diverger.
const env = loadClientEnv(
  fileURLToPath(new URL("../../", import.meta.url)),
  fileURLToPath(new URL("./", import.meta.url)),
);
const PORT = clientPort(env.WEB_APP_URL, 1420);

const apiProxy = {
  "/api": {
    target: apiProxyTarget(env),
    changeOrigin: true,
    // The Hermes connector upgrades /api/runtime-links/ws through the same
    // public origin as the SPA. This is required when a development origin is
    // published by Cloudflare Tunnel; HTTP proxying alone would leave the VPS
    // permanently disconnected.
    ws: true,
    timeout: 0,
    proxyTimeout: 0,
    configure: configureSseProxy,
  },
} as const;

export default defineConfig(({ command, mode, isPreview }) => {
  const isDevServe = command === "serve" && isPreview !== true && mode === "development";

  return {
  plugins: [
    react(),
    tailwindcss(),
    // Au build : le dictionnaire de la langue active part avec l'entrée
    // (`vite-locale-preload.ts`). Avant la CSP, dont l'empreinte couvre son script.
    localePreload(),
    // Au build : la CSP en tête de index.html (`vite-csp.ts`).
    contentSecurityPolicy(),
    // The pro screens (agency, billing, permission rules): only what
    // `OPENEDBOT_CONSOLE_PLUGINS` lists; empty is the solo console (`vite-pro-console.ts`).
    proConsole(proConsoleEntries(process.env.OPENEDBOT_CONSOLE_PLUGINS)),
    // `make solo-check`: which source modules each chunk carries (`vite-module-report.ts`).
    moduleReport(process.env.OPENEDBOT_CONSOLE_MODULE_REPORT),
    {
      name: "openedbot-dev-app-name",
      transformIndexHtml(html) {
        if (!isDevServe) return html;
        return html.replace(`<title>${PRODUCTION_APP_NAME}</title>`, `<title>${DEVELOPMENT_APP_NAME}</title>`);
      },
    },
  ],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname, [CONSOLE_HOST_PREFIX]: CONSOLE_HOST_DIR },
  },
  // Busts the persisted query cache (`lib/query-persister.ts`) and names the
  // build whenever the console sources change: a payload written by an
  // older client is never read by a newer one whose DTO shapes may differ.
  // Derived from the sources, never the clock (`vite-build-id.ts`), or every
  // deploy renames every chunk and empties every browser cache.
  define: {
    __OPENEDBOT_BUILD_ID__: JSON.stringify(buildId(fileURLToPath(new URL("../../", import.meta.url)), mode, loadEnv(mode, fileURLToPath(new URL("./", import.meta.url)), "VITE_"))),
  },
  server: {
    host: true,
    port: PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  // Same origin as `make dev`. Cannot run alongside Vite (`strictPort`).
  preview: {
    host: true,
    port: PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // KaTeX has no app-state dependency: its own chunk, loaded with the
        // thread's markdown (`thread-markdown.tsx` imports the renderer and its
        // stylesheet), never with the first load. Rolldown has no
        // `onlyExplicitManualChunks`: a `codeSplitting` group only captures the
        // listed modules and leaves the rest untouched. Same for the BoardUI
        // tree view of tool activity (7cd29326): motion and react-aria get
        // their own chunk, and the thread renders exactly as before.
        codeSplitting: {
          groups: [
            { name: "math-renderer", test: /[\\/]node_modules[\\/]katex[\\/]/ },
            {
              name: "tree-view",
              test: /[\\/]node_modules[\\/](motion|motion-dom|motion-utils|framer-motion|react-aria-components|react-aria|@react-aria|@react-stately|@react-types|@internationalized)[\\/]/,
            },
            // Everything the first load imports from node_modules and from the
            // UI kit, in one chunk each. Split per module (the UI kit is free of
            // side effects), the first load was ~80 files: on HTTP/1.1 its
            // six connections turned that into a waterfall (ADR 0001, D1b).
            // The groups only take `$initial` modules, so nothing lazy joins
            // the first load. Declared after the KaTeX and tree-view groups:
            // a module goes to the first group that matches.
            { name: "boot-vendor", test: /[\\/]node_modules[\\/]/, tags: ["$initial"] },
            { name: "boot-ui-kit", test: /[\\/]browser[\\/]ui-kit[\\/]/, tags: ["$initial"] },
          ],
        },
      },
    },
  },
  };
});
