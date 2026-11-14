import { describe, expect, test } from "bun:test";
import { checkReleaseWorkflows, readWorkflows, triggers } from "./release-workflows-contract";

const real = await readWorkflows();

function mutate(file: string, from: string | RegExp, to: string): Record<string, string> {
  const text = real[file]!;
  const next = text.replace(from, to);
  if (next === text) throw new Error(`the mutation of ${file} matched nothing: ${String(from)}`);
  return { ...real, [file]: next };
}

describe("release workflows contract", () => {
  test("the workflows of this tree hold it", () => {
    expect(checkReleaseWorkflows(real)).toEqual([]);
  });

  test("an artifact download, or a blocking or long-lived upload, is refused", () => {
    const download = mutate("desktop-release.yml", "      - name: Download the dmg from R2", "      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: r2-files\n      - name: Download the dmg from R2");
    expect(checkReleaseWorkflows(download).join("\n")).toContain("downloads an artifact");
    expect(checkReleaseWorkflows(mutate("core-ci.yml", /continue-on-error: true\n(\s+with:\n\s+name: desktop-linux-smoke)/, "continue-on-error: false\n$1")).join("\n")).toContain("non-blocking");
    expect(checkReleaseWorkflows(mutate("desktop-update-canary.yml", "retention-days: 1", "retention-days: 14")).join("\n")).toContain("one day");
  });

  test("the edge-setup hand-over is exact, mandatory and verified before publishing", () => {
    const fallback = mutate("edge-setup-release.yml", /(key: \$\{\{ needs\.verify\.outputs\.handoff \}\}\n\s+fail-on-cache-miss: true)/, "$1\n          restore-keys: edge-setup-signed-");
    expect(checkReleaseWorkflows(fallback).join("\n")).toContain("no restore-keys");
    const lenient = mutate("edge-setup-release.yml", /(key: \$\{\{ needs\.verify\.outputs\.handoff \}\}\n\s+)fail-on-cache-miss: true/, "$1fail-on-cache-miss: false");
    expect(checkReleaseWorkflows(lenient).join("\n")).toContain("fail-on-cache-miss");
    const unverified = mutate("edge-setup-release.yml", /\n {10}bash scripts\/check-signed-dir\.sh signed\n {10}make verify-signatures VERSION="\$VERSION" DIR=signed\n(\s+- name: Extract)/, "\n          true\n$1");
    expect(checkReleaseWorkflows(unverified).join("\n")).toContain("publish: must run check-signed-dir.sh");
  });

  test("the R2 token and the signing identity stay in their own job", () => {
    const leaked = mutate("edge-setup-release.yml", "        run: make build-all VERSION=\"$VERSION\"", "          TOKEN: ${{ secrets.CLOUDFLARE_R2_TOKEN }}\n        run: make build-all VERSION=\"$VERSION\"");
    expect(checkReleaseWorkflows(leaked).join("\n")).toContain("verify: only the publish job holds the R2 environment");
    const signer = mutate("edge-setup-release.yml", "      # The cache is read with the runner's own token, not GITHUB_TOKEN.\n      contents: read", "      contents: read\n      id-token: write");
    expect(checkReleaseWorkflows(signer).join("\n")).toContain("publish: only the verify job may sign");
  });

  test("the release workflow cannot be renamed: hosts verify its file name", () => {
    const { ["edge-setup-release.yml"]: workflow, ...rest } = real;
    expect(checkReleaseWorkflows({ ...rest, "edge-setup-publish.yml": workflow! }).join("\n")).toContain("never rename it");
  });

  test("a fork pull request never reaches a secret", () => {
    const target = mutate("core-ci.yml", "  pull_request:\n    branches: [main, develop]", "  pull_request_target:\n    branches: [main, develop]");
    expect(checkReleaseWorkflows(target).join("\n")).toContain("core-ci.yml: triggered by pull_request_target");
    const listed = mutate("gitleaks.yml", /^on:\n(?: .*\n)+/m, "on: [pull_request_target, push]\n");
    expect(checkReleaseWorkflows(listed).join("\n")).toContain("gitleaks.yml: triggered by pull_request_target");
    const leaked = mutate("core-ci.yml", "          GH_TOKEN: ${{ github.token }}", "          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}");
    expect(checkReleaseWorkflows(leaked).join("\n")).toContain("core-ci.yml: plan: references secrets. in a workflow triggered by pull_request");
  });

  test("the CI of pull requests runs for develop as well as main", () => {
    for (const file of ["core-ci.yml", "edge-setup-ci.yml"]) {
      const workflow = Bun.YAML.parse(real[file]!) as { on: { pull_request: { branches: string[] } } };
      expect(triggers(workflow)).toContain("pull_request");
      expect(workflow.on.pull_request.branches).toEqual(["main", "develop"]);
    }
  });

  test("an action pinned by tag is refused", () => {
    expect(checkReleaseWorkflows(mutate("edge-setup-release.yml", /actions\/cache\/save@[0-9a-f]{40}/, "actions/cache/save@v6")).join("\n")).toContain("not pinned by commit SHA");
  });

  test("a desktop job that trusts R2 without the verified digest is refused", () => {
    const unpinned = mutate("desktop-release.yml", 'fetch-r2-release.sh "$VERSION" r2 "$SUMS" "openedbot_${VERSION}_aarch64.dmg"', 'fetch-r2-release.sh "$VERSION" r2 - "openedbot_${VERSION}_aarch64.dmg"');
    expect(checkReleaseWorkflows(unpinned).join("\n")).toContain("mac: must download from R2");
  });
});
