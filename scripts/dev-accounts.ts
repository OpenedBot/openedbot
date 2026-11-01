/**
 * Prints the accounts `make db-seed` creates, once, when `make dev` starts.
 *
 * The login screen no longer fills them in: credentials belong in the
 * developer's terminal, not on a page. Same sources as the seed
 * (apps/api/scripts/seed.ts): E2E_EMAIL / E2E_PASSWORD for the personal owner,
 * DEV_STAFF_EMAIL / DEV_STAFF_PASSWORD for the staff backoffice. Reads the environment the Makefile already loaded.
 */
import { DEV_SEED_EMAIL, DEV_STAFF_EMAIL } from "../platform/config/src/api-config";

const env = process.env;
const password = env.E2E_PASSWORD?.trim();
const staffPassword = env.DEV_STAFF_PASSWORD?.trim();

const rows: Array<[string, string, string]> = [];
if (password) {
  rows.push(["owner", env.E2E_EMAIL?.trim() || DEV_SEED_EMAIL, password]);
}
if (staffPassword) {
  rows.push(["staff", (env.DEV_STAFF_EMAIL?.trim() || DEV_STAFF_EMAIL).toLowerCase(), staffPassword]);
}

const bold = env.NO_COLOR ? "" : "\x1b[1;36m";
const reset = env.NO_COLOR ? "" : "\x1b[0m";
if (!rows.length) {
  console.info(`${bold}[make] No dev account: E2E_PASSWORD is empty, run make setup.${reset}`);
} else {
  const emailWidth = Math.max(...rows.map(([, email]) => email.length));
  console.info(`${bold}[make] Dev accounts (make db-seed):${reset}`);
  for (const [role, email, secret] of rows) {
    console.info(`  ${role.padEnd(7)} ${email.padEnd(emailWidth)}  ${secret}`);
  }
}
