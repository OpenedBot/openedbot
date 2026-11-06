#!/usr/bin/env bun
/**
 * Runs the Linux shell's work in the image of `linux/Dockerfile` (ADR 0001,
 * D5), from a Mac or any Docker host: the working tree is streamed into a
 * throwaway container (tracked and untracked files, never ignored ones), with
 * caches for crates, the cargo target and Bun's packages kept in volumes.
 *
 *   bun apps/desktop-tauri/scripts/linux-docker.ts check [--arch x86_64|aarch64]
 *       cargo test, the Secret Service round trip under an unlocked GNOME
 *       Keyring, cargo clippy -D warnings
 *   bun apps/desktop-tauri/scripts/linux-docker.ts ci [--arch …]
 *       the CI job's commands: check, then an unsigned deb + AppImage and
 *       their start under Xvfb (scenario smoke)
 *   bun apps/desktop-tauri/scripts/linux-docker.ts e2e --version 1.1.0 [--arch …] [-- e2e options]
 *       the real path under Xvfb against the local API (scripts/linux-e2e.ts)
 *
 * `build-linux.ts --docker` builds the packages through the same helpers.
 * Container names start with `OPENEDBOT_LINUX_CONTAINER` (default
 * `openedbot-desktop-linux`).
 */
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { LinuxArch } from "./mac-identity";

const ROOT = path.resolve(import.meta.dir, "../../..");
const APP_DIR = path.join(ROOT, "apps/desktop-tauri");

export type { LinuxArch };
export const DOCKER_PLATFORM: Record<LinuxArch, string> = { x86_64: "linux/amd64", aarch64: "linux/arm64" };

export function imageFor(arch: LinuxArch): string {
  return `openedbot-desktop-linux:${arch}`;
}

export function containerName(arch: LinuxArch, purpose: string): string {
  return `${process.env.OPENEDBOT_LINUX_CONTAINER ?? "openedbot-desktop-linux"}-${purpose}-${arch}`;
}

export async function ensureImage(arch: LinuxArch): Promise<void> {
  await $`docker build --quiet --platform ${DOCKER_PLATFORM[arch]} -t ${imageFor(arch)} ${path.join(APP_DIR, "linux")}`;
}

/** The working tree as a tar input list: tracked and untracked files, ignored ones excluded, deleted ones skipped. */
async function workingTreeList(): Promise<string> {
  const listed = (await $`git ls-files -z -co --exclude-standard`.cwd(ROOT).quiet().text()).split("\0").filter(Boolean);
  const present = listed.filter((file) => existsSync(path.join(ROOT, file)) && !statSync(path.join(ROOT, file)).isDirectory());
  const list = path.join(tmpdir(), `openedbot-linux-files-${process.pid}-${Date.now()}.txt`);
  writeFileSync(list, `${present.join("\n")}\n`);
  return list;
}

export type ContainerRun = {
  arch: LinuxArch;
  purpose: string;
  /** Bash, run in /work/src once the tree is extracted and `bun install` done. */
  script: string;
  /** `host:container[:ro]` bind mounts. */
  mounts?: string[];
  env?: Record<string, string>;
};

/** Streams the working tree into a fresh container and runs `script` there. Returns its exit code. */
export async function runInContainer(run: ContainerRun): Promise<number> {
  await ensureImage(run.arch);
  const list = await workingTreeList();
  const volumes = (name: string) => `openedbot-desktop-linux-${name}-${run.arch}`;
  const inner = [
    "set -euo pipefail",
    "mkdir -p /work/src && tar -xf - -C /work/src && cd /work/src",
    "bun install --frozen-lockfile --silent",
    run.script,
  ].join("\n");
  const args = [
    "docker", "run", "--rm", "-i", "--name", containerName(run.arch, run.purpose), "--platform", DOCKER_PLATFORM[run.arch],
    // The local API and Mailpit of this Mac (OrbStack and Docker Desktop resolve it; plain Docker needs the mapping).
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${volumes("cargo")}:/opt/cargo/registry`,
    "-v", `${volumes("target")}:/cache/target`,
    "-v", `${volumes("bun")}:/opt/bun/install/cache`,
    "-e", "CARGO_TARGET_DIR=/cache/target",
    ...(run.mounts ?? []).flatMap((mount) => ["-v", mount]),
    ...Object.entries(run.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    imageFor(run.arch), "bash", "-c", inner,
  ];
  // No extended attributes (macOS provenance, quarantine): plain files only.
  const tar = Bun.spawn(["tar", "--no-xattrs", "-cf", "-", "-T", list], { cwd: ROOT, stdout: "pipe", stderr: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const docker = Bun.spawn(args, { stdin: tar.stdout, stdout: "inherit", stderr: "inherit" });
  const [tarCode, dockerCode] = await Promise.all([tar.exited, docker.exited]);
  rmSync(list, { force: true });
  if (tarCode !== 0) throw new Error(`tar of the working tree failed (${tarCode})`);
  return dockerCode;
}

/** What CI runs, same commands (`.github/workflows/core-ci.yml`, job desktop-linux). */
export const CHECK_SCRIPT = [
  "cd apps/desktop-tauri/src-tauri",
  "cargo test --locked",
  "../linux/session.sh --keyring cargo test --locked -- --ignored --exact linux::tests::secret_service_round_trip",
  "cargo clippy --all-targets --locked -- -D warnings",
].join("\n");

/**
 * The e2e and update runs reach this host's loopback services (API, Mailpit,
 * update feed, all bound to 127.0.0.1) through `host.docker.internal`, which
 * Docker Desktop and OrbStack forward to the host's loopback. Native Docker on
 * Linux maps that name to the bridge gateway instead: refuse rather than fail
 * later on an unreachable service.
 */
function requireLoopbackForwarding(): void {
  if (process.platform !== "darwin" && process.env.OPENEDBOT_LINUX_HOST_LOOPBACK !== "1") {
    fail("e2e and update need Docker Desktop or OrbStack on macOS (host.docker.internal reaches the host's 127.0.0.1); "
      + "elsewhere, bind the API, Mailpit and the feed where the container can reach them and set OPENEDBOT_LINUX_HOST_LOOPBACK=1");
  }
}

/** The Linux update test's feed port on this host (8799 is the macOS feed's). */
const UPDATE_FEED_PORT = 8798;

function fail(message: string): never {
  console.error(`[linux-docker] ${message}`);
  process.exit(2);
}

function builtArtifacts(version: string, arch: LinuxArch): string {
  const dir = path.join(APP_DIR, "dist-linux", version, arch);
  if (!existsSync(dir)) fail(`build ${version} first: ${dir} missing (make desktop-tauri-linux TAURI_VERSION=${version})`);
  return dir;
}

function evidenceDir(name: string): string {
  const dir = path.join(APP_DIR, "dist-linux/e2e", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const quoted = (words: string[]) => words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");

/** X.Y.Z[-tag] -> X.Y.(Z+1)[-tag]: a later version for the forged manifest. */
export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) throw new Error(`not a version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
}

/** The rest of the CI job (`desktop-linux` in core-ci.yml), after CHECK_SCRIPT. */
export const CI_SCRIPT = [
  `(${CHECK_SCRIPT.replaceAll("\n", " && ")})`,
  "bun apps/desktop-tauri/scripts/build-linux.ts --version 0.0.0-ci --unsigned --out /tmp/dist-linux",
  "apps/desktop-tauri/linux/session.sh --keyring bun apps/desktop-tauri/scripts/linux-e2e.ts --scenario smoke --artifacts /tmp/dist-linux/0.0.0-ci/$(uname -m) --evidence /evidence",
].join("\n");

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      arch: { type: "string", default: "x86_64" },
      version: { type: "string" },
      scenarios: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });
  const arch = values.arch as LinuxArch;
  if (!(arch in DOCKER_PLATFORM)) throw new Error("--arch must be x86_64 or aarch64");
  const [command, ...rest] = positionals;
  let code: number;
  if (command === "check") {
    code = await runInContainer({ arch, purpose: "check", script: CHECK_SCRIPT });
  } else if (command === "ci") {
    const evidence = evidenceDir(`ci-${arch}`);
    code = await runInContainer({
      arch,
      purpose: "ci",
      mounts: [`${evidence}:/evidence`],
      // Its own shell, so `set -e` holds inside it while a failure still leaves the evidence readable.
      script: ["status=0", `bash -euo pipefail -c '${CI_SCRIPT}' || status=1`, 'chown -R "$(stat -c %u:%g /evidence)" /evidence', 'exit "$status"'].join("\n"),
    });
  } else if (command === "e2e") {
    requireLoopbackForwarding();
    const version = values.version ?? fail("--version is required (a build in dist-linux/<version>/<arch>)");
    const artifacts = builtArtifacts(version, arch);
    const evidence = evidenceDir(`${version}-${arch}`);
    const scenarios = (values.scenarios ?? "signed-in,memory-only").split(",");
    const e2e = (mode: string, scenario: string) =>
      `apps/desktop-tauri/linux/session.sh ${mode} bun apps/desktop-tauri/scripts/linux-e2e.ts --scenario ${scenario} --artifacts /artifacts --evidence /evidence ${quoted(rest)} || status=1`;
    code = await runInContainer({
      arch,
      purpose: "e2e",
      mounts: [`${artifacts}:/artifacts:ro`, `${evidence}:/evidence`],
      script: [
        "status=0",
        ...scenarios.map((scenario) => {
          if (scenario === "signed-in") return e2e("--keyring", "signed-in");
          if (scenario === "memory-only") return e2e("--no-secret-service", "memory-only");
          return fail(`unknown scenario ${scenario}`);
        }),
        'chown -R "$(stat -c %u:%g /evidence)" /evidence',
        'exit "$status"',
      ].join("\n"),
    });
  } else if (command === "update") {
    requireLoopbackForwarding();
    // The AppImage of --from updates itself to --to from the local feed of
    // this host (update-feed.ts, Bun on 127.0.0.1:8798, a port of its own:
    // 8799 is the macOS feed of `make desktop-tauri-feed`), then refuses a
    // manifest for a later version signed with a throwaway key.
    const from = values.from ?? fail("--from is required");
    const to = values.to ?? fail("--to is required");
    const forged = bumpPatch(to);
    const platform = `linux-${arch}`;
    const feed = path.join(APP_DIR, "scripts/update-feed.ts");
    // Its own directory too (release/feed-linux): the macOS feed's manifest stays untouched.
    await $`bun ${feed} publish --feed feed-linux --version ${to} --platform ${platform} --port ${UPDATE_FEED_PORT}`;
    await $`bun ${feed} publish --feed feed-linux --version ${to} --announce ${forged} --forged-signature --platform ${platform} --manifest forged.json --port ${UPDATE_FEED_PORT}`;
    // Always its own server: a feed already on the port (another worktree's)
    // would serve other manifests and the test would prove nothing.
    if (await fetch(`http://127.0.0.1:${UPDATE_FEED_PORT}/`).then(() => true, () => false)) fail(`port ${UPDATE_FEED_PORT} is already in use: stop that server first`);
    const server = Bun.spawn(["bun", feed, "serve", "--feed", "feed-linux", "--port", String(UPDATE_FEED_PORT)], { stdout: "inherit", stderr: "inherit" });
    try {
      for (let attempt = 0; attempt < 50 && !(await fetch(`http://127.0.0.1:${UPDATE_FEED_PORT}/latest.json`).then((response) => response.ok, () => false)); attempt++) await Bun.sleep(100);
      const evidence = evidenceDir(`update-${from}-to-${to}-${arch}`);
      code = await runInContainer({
        arch,
        purpose: "update",
        mounts: [`${builtArtifacts(from, arch)}:/from:ro`, `${builtArtifacts(to, arch)}:/to:ro`, `${evidence}:/evidence`],
        script: [
          "status=0",
          `apps/desktop-tauri/linux/session.sh --keyring bun apps/desktop-tauri/scripts/linux-e2e.ts --scenario update --artifacts /from --to-artifacts /to --to-version ${to} --feed-port ${UPDATE_FEED_PORT} --evidence /evidence || status=1`,
          'chown -R "$(stat -c %u:%g /evidence)" /evidence',
          'exit "$status"',
        ].join("\n"),
      });
    } finally {
      server.kill();
    }
  } else {
    console.error("usage: linux-docker.ts check | ci | e2e --version V [--scenarios signed-in,memory-only] [-- e2e options] | update --from V --to V   [--arch x86_64|aarch64]");
    process.exit(2);
  }
  process.exit(code);
}
