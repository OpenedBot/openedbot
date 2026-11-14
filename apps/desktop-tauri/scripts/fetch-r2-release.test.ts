import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "fetch-r2-release.sh");
const BASE = "https://releases.example.test/desktop";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fetch-r2-release-"));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "origin/v0.1.1"), { recursive: true });
  // A fake curl: `-o OUT URL` copies origin/<path after BASE>, or fails like curl -f.
  writeFileSync(
    path.join(root, "bin/curl"),
    `#!/usr/bin/env bash
out= url=
while (($#)); do case "$1" in -o) out="$2"; shift 2 ;; --proto|--retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
src="${root}/origin/\${url#${BASE}/}"
[[ -f "$src" ]] || exit 22
cp "$src" "$out"
`,
  );
  chmodSync(path.join(root, "bin/curl"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function publish(files: Record<string, string>, sums = files): string {
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, "origin/v0.1.1", name), body);
  const text = Object.entries(sums).map(([name, body]) => `${sha(body)}  ${name}\n`).join("");
  writeFileSync(path.join(root, "origin/v0.1.1/SHA256SUMS"), text);
  return sha(text);
}

function run(...args: string[]) {
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RELEASES_BASE: BASE }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const FILES = { "openedbot_0.1.1_aarch64.dmg": "dmg", "openedbot_0.1.1_x86_64.deb": "deb" };

describe("fetch-r2-release.sh", () => {
  test("fetch job: every listed file, checked, and the digest to pin", () => {
    const digest = publish(FILES);
    const r = run("0.1.1", `${root}/dl`, "-");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe(`sums=${digest}`);
    expect(readFileSync(`${root}/dl/openedbot_0.1.1_x86_64.deb`, "utf8")).toBe("deb");
  });

  test("another job: only the named files, against the pinned digest", () => {
    const digest = publish(FILES);
    const r = run("0.1.1", `${root}/dl`, digest, "openedbot_0.1.1_aarch64.dmg");
    expect(r.code).toBe(0);
    expect(r.out).toContain("openedbot_0.1.1_aarch64.dmg OK");
    expect(r.out).not.toContain("deb OK");
  });

  test("R2 changed since the fetch job verified it: refused", () => {
    publish(FILES);
    const r = run("0.1.1", `${root}/dl`, "0".repeat(64), "openedbot_0.1.1_aarch64.dmg");
    expect(r.code).toBe(2);
    expect(r.err).toContain("another SHA256SUMS");
  });

  test("a file that does not match, is not listed, or a foreign name: refused", () => {
    const digest = publish({ ...FILES, "openedbot_0.1.1_aarch64.dmg": "tampered" }, FILES);
    expect(run("0.1.1", `${root}/dl`, digest, "openedbot_0.1.1_aarch64.dmg").err).toContain("does not match SHA256SUMS");
    expect(run("0.1.1", `${root}/dl`, digest, "openedbot_0.1.1_x86_64.AppImage").err).toContain("not listed");
    const foreign = publish({ "../escape": "x" });
    expect(run("0.1.1", `${root}/dl`, foreign).err).toContain("unexpected name");
    expect(run("0.1", `${root}/dl`, "-").code).toBe(2);
  });
});
