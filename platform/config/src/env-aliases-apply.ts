/**
 * Side-effect import, FIRST in every entry point (API, worker, alerting,
 * link gateway, dev scripts): applies the OHB_* -> OPENEDBOT_* fallback to
 * process.env before any module reads it (the logger reads OPENEDBOT_ENV at
 * load time). Removed with env-aliases.ts.
 */
import { applyEnvAliases } from "./env-aliases";

applyEnvAliases();
