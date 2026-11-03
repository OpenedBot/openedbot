/**
 * Side-effect import, FIRST in every entry point (API, worker, alerting,
 * link gateway, dev scripts): refuses to start while a retired OHB_* name is
 * set (legacy-env.ts), before any module reads the environment, and warns
 * about the OPENEDBOT_ names that no longer carry their own value.
 */
import { legacyEnvRefusal, warnDerivedEnv } from "./legacy-env";

const refusal = legacyEnvRefusal(process.env);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  // 78: EX_CONFIG, a configuration error a restart cannot fix.
  process.exit(78);
}
warnDerivedEnv();
