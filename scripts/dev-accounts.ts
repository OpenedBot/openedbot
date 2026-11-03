/**
 * Lists the accounts `make db-seed` creates, once, when `make dev` starts.
 *
 * The login screen no longer fills them in, and the terminal does not show
 * the passwords either: terminal output ends up in scrollback, logs and
 * screenshots. Each line names the account and where its password lives
 * (variable name and env file), never the value. Same sources as the seed
 * (apps/api/scripts/seed.ts): E2E_EMAIL / E2E_PASSWORD for the personal owner,
 * DEV_STAFF_EMAIL / DEV_STAFF_PASSWORD for the staff backoffice. Reads the
 * environment the Makefile already loaded; ENV_FILE names the env file.
 */
import { DEV_SEED_EMAIL, DEV_STAFF_EMAIL } from "../platform/config/src/api-config";

const env = process.env;
const envFile = env.ENV_FILE?.trim() || ".env.local";

const rows: Array<[string, string, string]> = [];
if (env.E2E_PASSWORD?.trim()) {
  rows.push(["owner", env.E2E_EMAIL?.trim() || DEV_SEED_EMAIL, "E2E_PASSWORD"]);
}
if (env.DEV_STAFF_PASSWORD?.trim()) {
  rows.push(["staff", (env.DEV_STAFF_EMAIL?.trim() || DEV_STAFF_EMAIL).toLowerCase(), "DEV_STAFF_PASSWORD"]);
}

const bold = env.NO_COLOR ? "" : "\x1b[1;36m";
const reset = env.NO_COLOR ? "" : "\x1b[0m";
if (!rows.length) {
  console.info(`${bold}[make] No dev account: E2E_PASSWORD is empty, run make setup.${reset}`);
} else {
  const emailWidth = Math.max(...rows.map(([, email]) => email.length));
  console.info(`${bold}[make] Dev accounts (make db-seed), password not shown:${reset}`);
  for (const [role, email, passwordName] of rows) {
    console.info(`  ${role.padEnd(7)} ${email.padEnd(emailWidth)}  password: ${passwordName} in ${envFile}`);
  }
}
