# Developing openedbot on Windows against a remote API

The shell (this repo) loads a console and talks to an API. The two are set
apart. A remote API (a staging deployment, a LAN host) usually serves **the
API only**: the console is the Vite server you run yourself on the same PC,
and it forwards `/api` to that API.

```text
 openedbot shell --loads--> console (apps/console, Vite) --/api proxy--> remote API
 (this repo)            http://localhost:1420     API_INTERNAL_URL
     |                                                              ^
     +------- native sign-in and token refresh (bearer) ------------+
```

## Prerequisites

- Windows 10 or 11, x64.
- Git for Windows.
- Bun for Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`. Bun only:
  no Node, npm, npx, yarn or pnpm.
- No `make` needed: every command below is a `bun run` script.

## Install

```powershell
git clone git@github.com:OpenedBot/openedbot.git openedbot  # monorepo: the console at the root, this app in apps/desktop
cd openedbot/apps/desktop
bun install
bun ./node_modules/electron/install.js   # only if node_modules/electron/dist is missing
bun run typecheck; bun test
```

## Run the shell against a remote API

1. Start the console on this PC, aimed at the API (second terminal):

   ```powershell
   cd ..\..
   bun install
   $env:API_INTERNAL_URL = "<api-origin>"   # the remote API origin
   bun run --cwd apps/console dev           # http://localhost:1420
   ```

   The console calls `/api` on its own origin and Vite proxies it to
   `API_INTERNAL_URL` (`apps/console/vite.config.ts`, `platform/config/src/client-env.ts`).
   Do not set `VITE_API_ORIGIN`: it is a production build setting.

2. Start the shell:

   ```powershell
   cd apps\desktop
   $env:OPENEDBOT_TARGET = "<api-origin>"; bun run dev
   ```

   A change in `src/main` restarts the app, in `src/preload` or `src/renderer`
   it reloads the window. Ctrl+R and Ctrl+Shift+I (DevTools) work in a dev run.

The API and the console are separate settings (environment wins over
`%APPDATA%\openedbot (dev)\config.json`, then the packaged defaults):

| Setting | Meaning |
|---|---|
| `OPENEDBOT_TARGET` | `prod`, or an API URL (a LAN host, for example `http://10.0.0.50:8790`). Fills in both of the next two. |
| `OPENEDBOT_API_ORIGIN` | The API base for sign-in. Beats the target. |
| `OPENEDBOT_CONSOLE_URL` | The console the window loads. Beats the target. Default for a URL target: `http://localhost:1420`. |

Same thing with another console: `$env:OPENEDBOT_TARGET="<api-origin>"; $env:OPENEDBOT_CONSOLE_URL="http://localhost:5173"; bun run dev`.

The console's proxy and the shell must name the same API. If the console proxies
to a local API while the shell signed in elsewhere, every call is refused.

Nothing is shared between backends: the session of a non-production API lives
in `tokens-<host>.bin` and a dev run in its own folder (`openedbot (dev prod)`,
`openedbot (dev)`); the diagnostics journal is `diagnostics.sqlite` in that
folder. A shell that is not on production says so in the window title and the
tray tooltip, and logs a warning.

Sign-in: an API that runs with `OPENEDBOT_ENV=preprod` offers the e-mail and
password form next to Google, and the sign-in page shows "API préprod". Such an
API never publishes credentials, so a dev run aimed at it reads the development
accounts from the development API (`OPENEDBOT_DEV_ACCOUNTS_API`, default
`http://localhost:1420`). Google needs
`<API_PUBLIC_URL>/api/auth/google/callback` registered on the API's Google client.

### CORS, cookies, CSRF with a `localhost` console

- No CORS: the browser only talks to `http://localhost:1420`, same origin;
  Vite forwards server-side. The shell's sign-in calls come from the main
  process (`net.fetch`), which sends no `Origin`.
- No cookie, no CSRF: the console in the shell sends `Authorization: Bearer`
  from the bridge. The API asks for CSRF on cookie sessions only.
- Calling the remote API straight from the browser (no proxy) would need
  `CORS_ALLOWED_ORIGINS=http://localhost:1420` on the API. Not needed here.
- The Windows PC must reach the remote API. If it is LAN only or behind
  an access gateway, the shell cannot sign in from outside.

## An unsigned zip, on request

```powershell
bun run compile                              # dist/
# optional: bake a target into the build (a test zip aimed at another API)
'{"target":"<api-origin>"}' | Set-Content -NoNewline -Encoding ascii dist\main\defaults.json
bun run package:win:zip                      # release\openedbot-<version>-win-x64.zip
```

Unzip anywhere and run `openedbot.exe`. Without `defaults.json` the build is
**production**, which is what a release must be: `make package-win` with no
`TARGET` does the same. SmartScreen warns on first run (unsigned): More info,
Run anyway. A target baked in is shown in the window title. If electron-builder
fails on a symbolic link, turn on Windows Developer Mode.

## Known limitations

- No code signing and no auto-update: every build is sideloaded by hand.
- The popup (openedbot Notch) is macOS only.
- Closing the window parks the app in the tray (the icon may sit in the
  hidden-icons area); Quit is in the tray menu.
- The global shortcut Ctrl+Shift+O takes that key from other apps while openedbot runs.
- `make logs` reads a macOS path; on Windows open
  `%APPDATA%\<userData folder>\diagnostics.sqlite` with any SQLite tool.
- Not verified on a Windows machine by the author of the target switch: run
  `bun run dev` with `OPENEDBOT_TARGET=<api-origin>` once and check the window title
  shows the API host.
