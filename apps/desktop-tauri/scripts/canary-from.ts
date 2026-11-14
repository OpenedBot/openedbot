#!/usr/bin/env bun
/**
 * Which release the blocking update canary installs first, for
 * desktop-release.yml (job canary-from).
 *
 *   bun apps/desktop-tauri/scripts/canary-from.ts --release X.Y.Z --stable X.Y.Z [--requested X.Y.Z] [--output FILE]
 *
 * - `--requested` (the workflow_dispatch input from_version): an explicit
 *   release to update from, which must be older than `--release`.
 * - Otherwise the release the stable channel serves (`--stable`):
 *   - older than `--release` (the normal path): the canary updates it to
 *     `--release` through the beta manifest (N-1 -> N), as always;
 *   - not older (a renumbering: the history restarted on 2026-11-12 at
 *     0.1.0 while stable still served 1.1.4; or a re-run after the stable
 *     promotion): no installed release can update itself to `--release`, the
 *     updater refuses a downgrade by design. The canary then runs its harness
 *     on `--release` itself (from = to): its published dmg is installed,
 *     nothing newer is offered, the forged update is still refused. When
 *     stable serves a higher number, its manifest names that one, newer than
 *     `--release`: the harness follows the beta manifest, which names
 *     `--release` before the tag.
 *
 * Prints a GitHub warning when the N-1 -> N proof is skipped, and writes
 * `from=` and `feed=` (empty: the canary's default feed) to `--output`
 * (the job's $GITHUB_OUTPUT), or to stdout without it.
 * Exit: 0 resolved, 2 refused (usage, not a version, requested not older).
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compareVersions, defaultFeed } from "./update-canary-mac";

export type CanaryFrom =
  | { mode: "update"; from: string; feed: "" }
  | { mode: "renumbering"; from: string; feed: string; notice: string };

export function resolveCanaryFrom(input: { release: string; stable: string; requested?: string }): CanaryFrom {
  const { release, stable } = input;
  const requested = input.requested ?? "";
  if (requested) {
    // compareVersions refuses anything but X.Y.Z.
    if (compareVersions(requested, release) >= 0) {
      throw new Error(`the release to update from (${requested}) is not older than ${release}: from_version names an earlier release`);
    }
    return { mode: "update", from: requested, feed: "" };
  }
  const order = compareVersions(stable, release);
  if (order < 0) return { mode: "update", from: stable, feed: "" };
  const why = order > 0
    ? `the stable channel serves ${stable}, a higher number than ${release} (renumbering: installed ${stable} apps do not update to a lower number and are reinstalled by hand)`
    : `the stable channel already serves ${release} (promoted before this run, or a re-run after the promotion)`;
  return {
    mode: "renumbering",
    from: release,
    // Stable names a higher number than the release: only the beta manifest names the release itself.
    feed: order > 0 ? defaultFeed("update", release) : "",
    notice: `${why}. No installed release can update itself to ${release}, so the N-1 -> N update proof is skipped: the canary runs its harness on ${release} (its published dmg installed, nothing newer offered, a forged update refused).`,
  };
}

function main(): number {
  const { values } = parseArgs({
    options: {
      release: { type: "string" },
      stable: { type: "string" },
      requested: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  if (!values.release || (!values.stable && !values.requested)) {
    console.error("usage: canary-from.ts --release X.Y.Z --stable X.Y.Z [--requested X.Y.Z] [--output FILE]");
    return 2;
  }
  let plan: CanaryFrom;
  try {
    plan = resolveCanaryFrom({ release: values.release, stable: values.stable ?? "", requested: values.requested });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (plan.mode === "renumbering") console.log(`::warning title=Update canary in harness mode::${plan.notice}`);
  const lines = `from=${plan.from}\nfeed=${plan.feed}\n`;
  if (values.output) appendFileSync(values.output, lines);
  else process.stdout.write(lines);
  return 0;
}

if (import.meta.main) process.exit(main());
