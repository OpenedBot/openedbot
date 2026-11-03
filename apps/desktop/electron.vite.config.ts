import { defineConfig } from "electron-vite";

// Main process and preload only. The window's UI is the remote console (its
// own Vite dev server in ../.. gives it HMR) and signin.html is a static page
// loaded from src/renderer, so there is no renderer bundle here (the scripts in
// package.json pass --ignoreConfigWarning so electron-vite stops reporting
// "renderer config is missing"; an empty renderer section would make it look
// for an index.html and start a renderer dev server for nothing). Entries are
// electron-vite's defaults (src/main/main.ts, src/preload/preload.ts); outputs
// keep the dist/ layout that package.json "main" and electron-builder expect.
// No "type": "module" in package.json: both come out as CommonJS, which a
// sandboxed preload requires (it is bundled whole, `electron` excepted).
export default defineConfig({
  main: {
    build: { outDir: "dist/main" },
  },
  preload: {
    build: { outDir: "dist/preload" },
  },
});
