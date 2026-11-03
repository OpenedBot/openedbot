import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_TIMED_OUT, sshGuardArgs, sshRemote } from "./ssh-remote";

/** Un faux `ssh` : le test n'a besoin d'aucun VPS pour prouver la borne. */
const root = mkdtempSync(join(tmpdir(), "ohb-ssh-remote-"));
function fakeSsh(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("sshRemote", () => {
  /**
   * La régression qui a coûté neuf heures de lien fermé : une session SSH figée
   * que rien ne récolte. Le faux ssh dort bien au-delà de la borne.
   */
  test("a hung session is reaped instead of waiting forever", async () => {
    const ssh = fakeSsh("hangs", "sleep 30");
    const startedAt = Date.now();
    const result = await sshRemote({ ssh, host: "vps", argv: ["curl", "health"], timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(REMOTE_TIMED_OUT);
    expect(result.stderr).toContain("abandon après");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test("a normal command keeps its exit code, stdout and stderr", async () => {
    const ok = fakeSsh("ok", 'echo "sortie"; echo "erreur" >&2; exit 0');
    expect(await sshRemote({ ssh: ok, host: "vps", argv: ["true"] })).toMatchObject({
      code: 0, timedOut: false, stdout: "sortie\n", stderr: "erreur\n",
    });
    const failing = fakeSsh("ko", "exit 7");
    expect(await sshRemote({ ssh: failing, host: "vps", argv: ["false"] })).toMatchObject({ code: 7, timedOut: false });
  });

  /** Le ticket d'enrôlement passe par stdin, jamais par argv. */
  test("stdin reaches the remote command", async () => {
    const echo = fakeSsh("cat", "cat");
    const result = await sshRemote({ ssh: echo, host: "vps", argv: ["edge-setup", "link"], stdin: "ticket\n" });
    expect(result.stdout).toBe("ticket\n");
    expect(result.code).toBe(0);
  });

  /** Le minuteur dur n'est que le dernier filet : la session est bornée d'abord. */
  test("every call carries the session guards", async () => {
    const args = fakeSsh("args", 'echo "$@"');
    const result = await sshRemote({ ssh: args, host: "vps", argv: ["uptime"] });
    for (const guard of ["BatchMode=yes", "ConnectTimeout=10", "ServerAliveInterval=5", "ServerAliveCountMax=3"]) {
      expect(result.stdout).toContain(guard);
    }
    expect(result.stdout.trimEnd().endsWith("vps uptime")).toBe(true);
    expect(sshGuardArgs()).toHaveLength(8);
  });
});
