// Side-effect import, first in main.ts: see legacy-env.ts.
import { desktopLegacyEnvRefusal } from "./legacy-env";

const refusal = desktopLegacyEnvRefusal(process.env);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(78);
}
