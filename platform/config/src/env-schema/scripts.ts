import type { EnvVar } from "./types";

/** Operator scripts and the Makefile. Part of `ENV_SCHEMA` (`../env-schema.ts`), in schema order. */
export const SCRIPTS_ENV: readonly EnvVar[] = [
  // ------------------------------------------------------------- scripts ---
  {
    name: "ENV_FILE",
    scope: "scripts",
    tier: "default_only",
    doc: "Environment file loaded by the Makefile and scripts/setup.sh, and read by env-check, env-audit and env-template (default .env.local).",
  },
  {
    name: "OPENEDBOT_DEV_PROFILE",
    scope: "scripts",
    tier: "default_only",
    doc: "Development profile passed by make: fake (default) or external.",
  },
  {
    name: "OPENEDBOT_POSTGRES_CONTAINER",
    scope: "scripts",
    tier: "local",
    doc: "Name of the shared dev-infra PostgreSQL container used by db.sh; never created by this repository.",
    example: "infra-postgres",
  },
  {
    name: "OPENEDBOT_DATABASE_NAME",
    scope: "scripts",
    tier: "local",
    doc: "Name of the local development database.",
    example: "ohb",
  },
  {
    name: "OPENEDBOT_POSTGRES_PORT",
    scope: "scripts",
    tier: "default_only",
    doc: "Host port of the shared dev-infra PostgreSQL container, read by dev-reset-data.ts (default 5432).",
  },
  {
    name: "OPENEDBOT_DEV_RESET_CONFIRM",
    scope: "scripts",
    tier: "default_only",
    doc: "Refuses apps/api/scripts/dev-reset-data.ts without `yes`: it destroys local application data.",
  },
  {
    name: "POSTGRES_DB",
    scope: "scripts",
    tier: "default_only",
    doc: "Maintenance database of the shared dev-infra PostgreSQL container (default devhub); read inside the container, never reset.",
  },
  {
    name: "POSTGRES_USER",
    scope: "scripts",
    tier: "default_only",
    doc: "Superuser of the shared dev-infra PostgreSQL container, read inside the container by the db scripts.",
  },
  {
    name: "FAKE_HERMES_HOST",
    scope: "scripts",
    tier: "default_only",
    doc: "Listen address of tests/fake-hermes/server.ts (default 127.0.0.1).",
  },
  {
    name: "FAKE_HERMES_PORT",
    scope: "scripts",
    tier: "default_only",
    doc: "Listen port of the fake Hermes gateway (default 18642).",
  },
  {
    name: "FAKE_HERMES_TOKEN",
    scope: "scripts",
    tier: "default_only",
    doc: "Bearer the fake Hermes gateway expects; `make fake-hermes` passes DEV_HERMES_TOKEN.",
    secret: true,
  },
  {
    name: "FAKE_HERMES_CAPACITY",
    scope: "scripts",
    tier: "default_only",
    doc: "Concurrent runs the fake Hermes gateway accepts before answering 429.",
  },
  {
    name: "FAKE_HERMES_DELAY_MS",
    scope: "scripts",
    tier: "default_only",
    doc: "Artificial latency of the fake Hermes gateway in ms.",
  },
  {
    name: "VITE_API_ORIGIN",
    scope: "web",
    tier: "production",
    doc: "Origin the PWA calls, baked in at build time. Production only: in development the SPA calls /api on its own origin and Vite proxies it, so env-check refuses a local value.",
    productionExample: "https://api.example.invalid",
  },
  {
    name: "DEV_HERMES_PROFILE",
    scope: "scripts",
    tier: "default_only",
    doc: "Capability profile expected by the live canary (tests/e2e/hermes-contract.ts); no default.",
  },
  {
    name: "DEV_HERMES_PROVIDER",
    scope: "scripts",
    tier: "default_only",
    doc: "Inference provider expected by the live canary (tests/e2e/hermes-contract.ts); no default.",
  },
  {
    name: "DEV_HERMES_MODEL",
    scope: "scripts",
    tier: "default_only",
    doc: "Model requested by the live canary (tests/e2e/hermes-contract.ts); falls back to the caller's choice.",
  },
];
