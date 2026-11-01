import { app } from "electron";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { log } from "./log";

export const PROTOCOL = "ohb";
export const PROTOCOL_REDIRECT_URI = "ohb://auth/callback";
export const LOOPBACK_PORT = 47813;
export const LOOPBACK_REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

// Both URIs are the only ones the API accepts as redirectUri.
export type RedirectUri = typeof PROTOCOL_REDIRECT_URI | typeof LOOPBACK_REDIRECT_URI;

export type DeepLinkHandle = {
  /** The redirectUri to announce to the API, decided once at startup. */
  redirectUri: RedirectUri;
  /** Starts the loopback listener (no-op when the custom protocol is in use). */
  startLoopback(): Promise<void>;
  stopLoopback(): void;
  /** Feeds a second-instance command line; fires onCallback if it carries the auth deep link. */
  handleCommandLine(argv: readonly string[]): void;
};

function isAuthCallback(raw: string): boolean {
  // Only the shape is checked. The query (code, state) is neither read nor
  // logged: the claim by polling is the source of truth, the callback only
  // tells us the browser step is over.
  return raw.startsWith(PROTOCOL_REDIRECT_URI);
}

function registerProtocol(): boolean {
  try {
    // Unpackaged (electron . on a dev box) the OS must relaunch
    // `electron.exe <app path>`, not a bare electron.exe.
    if (process.defaultApp && process.argv[1]) {
      return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
    return app.setAsDefaultProtocolClient(PROTOCOL);
  } catch (error) {
    log.warn(`protocol registration threw (${error instanceof Error ? error.message : "error"})`);
    return false;
  }
}

/**
 * Registers the ohb:// protocol and installs the open-url hook. Call once at
 * startup, after the single-instance lock is held (a second launch would
 * otherwise rewrite the OS registration of the running instance).
 */
export function setupDeepLink(onCallback: () => void): DeepLinkHandle {
  const registered = registerProtocol();
  if (!registered) log.warn("ohb:// protocol registration failed, falling back to the loopback callback");

  // macOS delivers the URL through this event; kept so the module is not
  // Windows-only by accident even though macOS is out of V1 scope.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (isAuthCallback(url)) onCallback();
  });

  let server: Server | null = null;

  return {
    redirectUri: registered ? PROTOCOL_REDIRECT_URI : LOOPBACK_REDIRECT_URI,

    startLoopback(): Promise<void> {
      if (registered || server) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const created = createServer((request, response) => {
          const url = new URL(request.url ?? "/", `http://127.0.0.1:${LOOPBACK_PORT}`);
          if (request.method !== "GET" || url.pathname !== "/callback") {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(
            "<!doctype html><meta charset=utf-8><title>openedbot</title>" +
              "<body style=\"font-family:system-ui;margin:3rem\"><h1>Connexion terminée</h1>" +
              "<p>Vous pouvez fermer cet onglet et revenir à openedbot.</p></body>",
          );
          onCallback();
        });
        created.once("error", reject);
        // 127.0.0.1 only: never reachable from another machine.
        created.listen(LOOPBACK_PORT, "127.0.0.1", () => {
          created.off("error", reject);
          created.on("error", (error) => log.error("loopback server error", error));
          server = created;
          resolve();
        });
      });
    },

    stopLoopback(): void {
      server?.close();
      server = null;
    },

    handleCommandLine(argv: readonly string[]): void {
      if (argv.some(isAuthCallback)) onCallback();
    },
  };
}
