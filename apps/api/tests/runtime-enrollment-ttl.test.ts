import { expect, test } from "bun:test";
import { ENROLLMENT_TTL_MS } from "../src/routes/runtimes/runtime-enrollment-routes";

// The pairing ticket is a single-use bearer pasted on a server: a short life
// bounds what a leaked one is worth (edge-setup hardening, pairing).
test("an enrollment ticket lives fifteen minutes at most", () => {
  expect(ENROLLMENT_TTL_MS).toBeGreaterThan(0);
  expect(ENROLLMENT_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
});
