// Docker healthcheck: `bun apps/worker/src/healthcheck.ts <health file>`.
// The path is an argument because a healthcheck exec skips the entrypoint
// that loads the worker's environment.
import { isLoopHealthy } from "./infrastructure/loop-health";

const file = process.argv[2]?.trim();
process.exit(file && (await isLoopHealthy(file)) ? 0 : 1);
