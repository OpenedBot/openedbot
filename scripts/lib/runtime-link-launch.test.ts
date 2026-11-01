import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function fixture(explicitUrl = false) {
  const root = await mkdtemp(join(tmpdir(), "ohb-link-launch-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "apps/link-gateway"), { recursive: true });
  await copyFile(resolve(import.meta.dir, "../runtime-link-launch.sh"), join(root, "scripts/runtime-link-launch.sh"));
  // Un seul fichier d'environnement (ENV_DIR_OF_SCOPE) : la racine porte aussi
  // RUNTIME_LINK_PORT, qui vivait dans apps/api/.env.local.
  await writeFile(join(root, ".env.local"), `RUNTIME_LINK_MODE=embedded\nRUNTIME_LINK_PORT=9012\nTEST_LAUNCH_SECRET=api-secret\n${explicitUrl ? "RUNTIME_LINK_INTERNAL_URL=http://dedicated:9123\n" : ""}`);
  const executable = join(root, "fake bun");
  await writeFile(executable, `#!/usr/bin/env bash
set -eu
[ "$TEST_LAUNCH_SECRET" = api-secret ] || exit 3
printf '%s\\n' "$RUNTIME_LINK_MODE" "$RUNTIME_LINK_INTERNAL_URL" "$PWD" "$1" "$$"
`);
  await chmod(executable, 0o700);
  const env = { ...process.env };
  for (const key of ["RUNTIME_LINK_MODE", "RUNTIME_LINK_INTERNAL_URL", "RUNTIME_LINK_PORT", "TEST_LAUNCH_SECRET"]) delete env[key];
  return { root, executable, env };
}

for (const explicit of [false, true]) {
  test(`launcher loads canonical env and execs its child (explicit URL: ${explicit})`, async () => {
    const { root, executable, env } = await fixture(explicit);
    try {
      const child = Bun.spawn(["bash", join(root, "scripts/runtime-link-launch.sh"), executable], { env, stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stdout.trim().split("\n")).toEqual(["separate", explicit ? "http://dedicated:9123" : "http://127.0.0.1:9012", root, "apps/link-gateway/src/main.ts", String(child.pid)]);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("SIGTERM reaches the exec'd gateway process directly", async () => {
  const { root, executable, env } = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(executable, `#!/usr/bin/env bash
trap 'printf "stopped\\n"; exit 0' TERM
printf 'ready\\n'
while true; do read -r -t 0.05 unused || :; done
`);
    child = Bun.spawn(["bash", join(root, "scripts/runtime-link-launch.sh"), executable], { env, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("stopped\n");
    reader.releaseLock();
  } finally {
    child?.kill();
    await rm(root, { recursive: true, force: true });
  }
});
