import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  devEnvFilePath,
  ensureDevPasswords,
  generateDevPassword,
  upsertEnvLine,
} from "../scripts/dev-passwords";

describe("dev seed passwords", () => {
  test("a generated password is random, long and shell-safe", () => {
    const a = generateDevPassword();
    const b = generateDevPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  test("upsertEnvLine replaces an empty line and appends a missing one", () => {
    expect(upsertEnvLine("A=1\nE2E_PASSWORD=\nB=2\n", "E2E_PASSWORD", "x")).toBe("A=1\nE2E_PASSWORD=x\nB=2\n");
    expect(upsertEnvLine("A=1\n", "DEV_STAFF_PASSWORD", "y")).toBe("A=1\nDEV_STAFF_PASSWORD=y\n");
    expect(upsertEnvLine("", "E2E_PASSWORD", "z")).toBe("E2E_PASSWORD=z\n");
  });

  test("missing passwords are generated once and stored privately; existing ones are kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-dev-pw-"));
    const file = join(dir, ".env.local");
    writeFileSync(file, "E2E_EMAIL=dev@ohb.local\nE2E_PASSWORD=\n");
    const env: Record<string, string | undefined> = { DEV_STAFF_PASSWORD: "kept" };
    let n = 0;
    const generated = ensureDevPasswords(env, file, () => `gen-${++n}`);
    expect(generated).toEqual(["E2E_PASSWORD"]);
    expect(env.E2E_PASSWORD).toBe("gen-1");
    expect(readFileSync(file, "utf8")).toBe("E2E_EMAIL=dev@ohb.local\nE2E_PASSWORD=gen-1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ensureDevPasswords(env, file, () => "never")).toEqual([]);
  });

  test("the env file follows OHB_ENV_FILE, else the repository .env.local", () => {
    expect(devEnvFilePath({}, "/repo")).toBe("/repo/.env.local");
    expect(devEnvFilePath({ OHB_ENV_FILE: ".env.other" }, "/repo")).toBe("/repo/.env.other");
  });
});
