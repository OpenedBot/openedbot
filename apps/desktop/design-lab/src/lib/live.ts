import { useSyncExternalStore } from "react";

/*
  Live iteration. The lab's Vite plugin sends `ohb:renderer-changed` whenever
  a file of openedbot-desktop/src/renderer changes. A template stylesheet only bumps
  `styles` (previews swap the <link>); the markup, the base stylesheet or an
  asset bumps `page` (previews reload the iframe).
*/
type Revision = { styles: number; page: number };

let revision: Revision = { styles: 0, page: 0 };
const listeners = new Set<() => void>();

function bump(kind: keyof Revision): void {
  revision = { ...revision, [kind]: revision[kind] + 1 };
  for (const listener of listeners) listener();
}

if (import.meta.hot) {
  import.meta.hot.on("ohb:renderer-changed", (data: { file: string }) => {
    bump(data.file.startsWith("templates") ? "styles" : "page");
  });
}

export function useRevision(): Revision {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
  );
}
