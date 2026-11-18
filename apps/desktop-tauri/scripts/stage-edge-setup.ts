import { $ } from "bun";
import path from "node:path";

/** Package the connector from the same revision as the desktop app. */
export async function stageEdgeSetup(root: string, staging: string): Promise<string> {
  const description = await $`git describe --tags --match edge-setup/v* --always --dirty`.cwd(root).quiet().nothrow();
  const version = description.exitCode === 0 ? description.stdout.toString().trim().replace(/^edge-setup\//, "") : "dev";
  const binary = path.join(staging, "edge-setup");
  await $`go build -trimpath -buildvcs=false -ldflags ${`-s -w -X main.version=${version}`} -o ${binary} ./cmd/edge-setup`
    .cwd(path.join(root, "edge-setup")).env({ ...process.env, CGO_ENABLED: "0" });
  return binary;
}
