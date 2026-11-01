import type { EnvVar } from "./types";
import { DEVELOPMENT_DATABASE_URL_API } from "./types";

/** The API server: address, URLs, events, support, and the development and link tooling it reads. Part of `ENV_SCHEMA` (`../env-schema.ts`), in schema order. */
export const API_ENV: readonly EnvVar[] = [
  // ----------------------------------------------------------------- api ---
  {
    name: "API_HOST",
    scope: "api",
    tier: "default_only",
    doc: "Listen address of the API (default 127.0.0.1).",
  },
  {
    name: "API_PORT",
    scope: "shared",
    tier: "default_only",
    doc: "Listen port of the API (default 8790); also the port API_INTERNAL_URL and API_PUBLIC_URL default to, so the worker follows it.",
  },
  {
    name: "API_DB_MAX",
    scope: "api",
    tier: "default_only",
    doc: "Size of the API PostgreSQL pool (default 32).",
  },
  {
    name: "API_MAX_BODY_BYTES",
    scope: "api",
    tier: "default_only",
    doc: "Upper bound of an HTTP request body accepted by the API.",
  },
  {
    name: "API_IDLE_TIMEOUT",
    scope: "api",
    tier: "default_only",
    doc: "Bun idle timeout of the API server in seconds, 1 to 255 (default 255).",
  },
  {
    name: "OPENEDBOT_PLUGINS",
    scope: "api",
    tier: "default_only",
    doc: "Comma-separated module specifiers of pro plug-ins (@openedbot/pro-*); empty or unset is solo mode.",
  },
  {
    name: "OPENEDBOT_CONSOLE_PLUGINS",
    scope: "web",
    tier: "default_only",
    doc:
      "Build time: comma-separated console modules of the pro packages (absolute paths to `packages/pro-*/console/index.ts`, " +
      "or a core seam such as `@openedbot/console/agency`); empty or unset builds a solo console with no pro screen. " +
      "The hosted console is built with it (`make build` refuses without it, or OPENEDBOT_CONSOLE_MODE=solo).",
  },
  {
    name: "OPENEDBOT_CONSOLE_MODE",
    scope: "scripts",
    tier: "default_only",
    doc: "`solo`: `make build` accepts an empty OPENEDBOT_CONSOLE_PLUGINS and ships a solo console (no agency, billing or permission-rule screens).",
  },
  {
    name: "OPENEDBOT_CONSOLE_MODULE_REPORT",
    scope: "scripts",
    tier: "default_only",
    doc: "Build time: path where the console build writes its chunk/module report (`make solo-check`). Unset: no report.",
  },
  {
    name: "API_TRUST_PROXY",
    scope: "api",
    tier: "default_only",
    doc: "`1`/`true` only behind a trusted reverse proxy that sets X-Forwarded-*.",
  },
  {
    name: "API_DATABASE_URL",
    scope: "api",
    tier: "local",
    requiredWhen: { environment: ["development", "production"] },
    doc: "PostgreSQL DSN of the API role (RLS tenant role, never the migrator).",
    example: DEVELOPMENT_DATABASE_URL_API,
    productionExample: "",
    secret: true,
  },
  {
    name: "DEV_RESET_DATABASE_URL",
    scope: "api",
    tier: "local",
    doc: "Development only: owner DSN used by POST /api/onboarding/reset {\"scope\":\"full\"}; empty leaves the full wipe to make db-reset-keep-users.",
    example: "",
    secret: true,
  },
  {
    name: "API_PUBLIC_URL",
    scope: "api",
    tier: "production",
    requiredWhen: { environment: ["production"] },
    doc: "Public HTTPS origin of the API; outside production it defaults to localhost on API_PORT.",
    example: "https://api.example.invalid",
  },
  {
    name: "WEB_APP_URL",
    scope: "web",
    tier: "local",
    requiredWhen: { environment: ["production"] },
    doc: "Canonical origin of the PWA. Billing returns and enrolment links point here, and it is always allowed by CORS.",
    example: "http://localhost:1420",
    productionExample: "https://app.example.invalid",
  },
  {
    name: "CORS_ALLOWED_ORIGINS",
    scope: "web",
    tier: "default_only",
    doc: "Extra browser origins allowed by CORS, comma-separated. WEB_APP_URL and ADMIN_PUBLIC_URL are always allowed and need no repeating.",
    productionExample: "",
  },
  {
    name: "ADMIN_PUBLIC_URL",
    scope: "admin",
    tier: "local",
    doc: "Staff backoffice origin (external plug-in). Auto-included in CORS; HTTPS required in production.",
    example: "http://localhost:1421",
    productionExample: "https://admin.example.invalid",
  },
  {
    name: "API_EVENTS_FALLBACK_POLL_MS",
    scope: "api",
    tier: "default_only",
    doc: "Fallback poll interval of /api/events in ms, at least 250 (default 5000).",
  },
  {
    name: "API_EVENTS_REPLAY_WINDOW_MS",
    scope: "api",
    tier: "default_only",
    doc: "Time window replayed to a client starting from cursor 0 (default 15 minutes).",
  },
  {
    name: "API_EVENTS_REPLAY_WINDOW_EVENTS",
    scope: "api",
    tier: "default_only",
    doc: "Maximum events replayed to a client starting from cursor 0 (default 200).",
  },
  {
    name: "API_SUPPORT_POLL_MS",
    scope: "api",
    tier: "default_only",
    doc: "Poll interval of the support desk stream in ms, at least 250 (default 1000).",
  },
  {
    name: "WORKER_SUPPORT_EVENTS_RETENTION_DAYS",
    scope: "worker",
    tier: "default_only",
    doc: "Days a closed support thread keeps its stream events (default 30).",
  },
  {
    name: "WORKER_SUPPORT_RETENTION_DAYS",
    scope: "worker",
    tier: "default_only",
    doc: "Days a closed support thread is kept before purge (default 180).",
  },
  // DEV_HERMES_URL / DEV_HERMES_TOKEN are read by apps/api/scripts/seed.ts
  // only under the fake profile, which itself runs in the external runtime mode
  // and writes both values through scripts/setup.sh. The fake and external
  // profiles are therefore indistinguishable by runtime mode, and a real
  // external host registers its runtime through the application: neither
  // variable can be `requiredWhen` any mode. They stay external-only so that
  // `env-audit` prunes them from an obsolete `.env.local`.
  {
    name: "DEV_HERMES_URL",
    scope: "shared",
    tier: "local",
    runtimeModes: ["external"],
    doc: "Seed-only Hermes gateway (`make db-seed`), written by the fake profile (http://127.0.0.1:18642); optional otherwise. No lab default.",
    example: "",
  },
  {
    name: "DEV_HERMES_TOKEN",
    scope: "scripts",
    tier: "local",
    runtimeModes: ["external"],
    doc: "Seed-only bearer of DEV_HERMES_URL, written by the fake profile (fake-hermes-token); optional otherwise.",
    example: "",
    secret: true,
  },
  {
    name: "E2E_EMAIL",
    scope: "web",
    tier: "local",
    doc: "Account seeded by `make db-seed`; in OPENEDBOT_ENV=development /login pre-fills it.",
    example: "dev@ohb.local",
  },
  {
    name: "E2E_PASSWORD",
    scope: "web",
    tier: "local",
    doc: "Password of the seeded development accounts (dev@ohb.local; development autofill only). Generated at random by `make setup` or the first `make db-seed`; never commit a value.",
    example: "",
    secret: true,
  },
  // Read by apps/console/scripts/pwa-mobile-pass.ts only, and only when the user
  // asks for a browser pass. Declared here so the schema stays exhaustive.
  {
    name: "E2E_ORIGIN",
    scope: "web",
    tier: "default_only",
    doc: "Origin the browser pass drives (default http://localhost:1420).",
  },
  {
    name: "E2E_PHONE_WIDTH",
    scope: "web",
    tier: "default_only",
    doc: "Viewport width in CSS pixels of the mobile browser pass (default 430).",
  },
  {
    name: "E2E_PHONE_HEIGHT",
    scope: "web",
    tier: "default_only",
    doc: "Viewport height in CSS pixels of the mobile browser pass (default 932).",
  },
  {
    name: "EDGE_SETUP_DIR",
    scope: "scripts",
    tier: "default_only",
    doc: "Checkout of the sibling repository OpenedBot/edge-setup read by `make contract-check` and the twin tests (default ../edge-setup); they fail when it is absent.",
  },
  {
    name: "LINK_TUNNEL_PORT",
    scope: "scripts",
    tier: "default_only",
    doc: "VPS loopback port `make link-dev-up` binds for this workstation's tunnel (default: derived from the instance name in 8800-8899, so each workstation has its own); set it in .env.local only to resolve a collision.",
  },
  {
    name: "LINK_TUNNEL_LOCAL_PORT",
    scope: "scripts",
    tier: "default_only",
    doc: "Local loopback port `make link-dev-up` forwards to (default API_PORT, or RUNTIME_LINK_PORT in separate mode).",
  },
  {
    name: "LINK_TUNNEL_SSH",
    scope: "scripts",
    tier: "default_only",
    doc: "SSH client used by `make link-dev-up` (default ssh from PATH).",
  },
  {
    name: "HOST",
    scope: "scripts",
    tier: "default_only",
    doc: "Fallback for `--host` when scripts/link-dev.ts runs without it; `make link-dev-up HOST=user@vps` always passes --host explicitly.",
  },
  {
    name: "LINK_DEV_INSTANCE",
    scope: "scripts",
    tier: "default_only",
    doc: "Connector instance `make link-dev-up` links on the VPS (default: this workstation's hostname, e.g. dev-01, so several workstations stay linked at once and an unqualified run never takes the production link over); LINK_DEV_INSTANCE=default opts into that single production slot.",
  },
  {
    name: "LINK_DEV_RUNTIME_NAME",
    scope: "scripts",
    tier: "default_only",
    doc: "Display name of the runtime `make link-dev-up` enrolls in the local openedbot (default `<instance> (poste)`).",
  },
  {
    name: "LINK_DEV_EMAIL",
    scope: "scripts",
    tier: "default_only",
    doc: "Local openedbot account `make link-dev-up` logs in as to open an enrollment ticket (default E2E_EMAIL, then dev@ohb.local).",
  },
  {
    name: "LINK_DEV_ORGANIZATION_SLUG",
    scope: "scripts",
    tier: "default_only",
    doc: "Optional organization slug `make link-dev-up` selects at login; the enrollment is refused unless the session reads back that organization (default: the account's default workspace).",
  },
  {
    name: "LINK_DEV_PASSWORD",
    scope: "scripts",
    tier: "default_only",
    doc: "Password of LINK_DEV_EMAIL (default E2E_PASSWORD).",
    secret: true,
  },
  {
    name: "TICKET",
    scope: "scripts",
    tier: "default_only",
    doc: "`make link-dev-up TICKET=ask`: link with an enrollment ticket opened in the console and pasted without echo, instead of logging in, so the runtime lands in the workspace of whoever opened it (a Google account included). `ask` is the only value: the ticket itself never goes on a command line.",
  },
  {
    name: "LINK_DEV_TICKET",
    scope: "scripts",
    tier: "default_only",
    doc: "What `make link-dev-up` passes from TICKET to scripts/link-dev-pass.sh (only `ask`); see TICKET.",
  },
  {
    name: "DEV_STAFF_EMAIL",
    scope: "admin",
    tier: "default_only",
    doc: "Seeded staff account pre-filled by the backoffice /login in development (default staff@ohb.dev).",
  },
  {
    name: "DEV_STAFF_PASSWORD",
    scope: "admin",
    tier: "default_only",
    doc: "Password of the seeded staff account (development autofill only). Generated at random into the env file by `make setup` or the first `make db-seed`; never commit a value.",
    secret: true,
  },
];
