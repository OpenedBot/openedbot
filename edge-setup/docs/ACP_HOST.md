# Experimental OpenCode host on Linux

`edge-setup up --engine acp:opencode --yes` selects OpenCode instead of
Hermes. Linux with systemd is required. The default remains Hermes. Repeat
`--engine acp:opencode` when running `up` again. An installed host cannot
switch engines: uninstall it first. `--sandbox` is a Hermes option and is
refused with ACP.

The state records `engine: "acp:opencode"` and the applied `opencode` pin.
An omitted engine in state means Hermes. Upgrade, doctor, reset and uninstall
use that state. Enrollment uses it for `hello`; the installed connector units
carry the same non-secret identity for daemon startup. ACP announces
`engine: "acp:opencode"` and `engineVersion: "1.19.6"`, without
`hermesVersion`.

The connector still targets `127.0.0.1:8642`. `openedbot-acp-bridge.service`
serves that address, authenticates using the existing `API_SERVER_KEY` in
`/srv/hermes/data/runtime.env`, and executes `/usr/local/lib/openedbot-opencode/opencode acp`
through `account.AsUser` and `runuser -u hermes`. The profile directory is the
working directory of each agent. The account is checked for sudo/docker group
membership. Re-running `up` preserves the bearer through the same environment
writer used by the Hermes installer.

The runtime root and bearer files belong to root. Profiles under
`/srv/hermes/data/acp-profiles` and agent data under
`/srv/hermes/data/acp-home` belong to the service account. The bridge journal
under `/var/lib/openedbot-acp-bridge` is root-only. The root bridge receives
the bearer as a systemd credential, outside the agent environment. Its unit
hides `/run/credentials`, including connector credentials owned by the shared
service user; its own credential is bound under a root-only runtime directory.
SETUID and SETGID permit `runuser`; KILL permits termination of the resulting
service-user process groups. The unit keeps the applicable operator hardening.
It permits executable JIT memory because OpenCode embeds Bun.

The ACP operator announces only `profile_management`. It serves capability
discovery and profile creation, inventory for existence checks, and deletion.
Creating a profile makes `<profiles root>/<slug>` owned by the service account
with mode 0700. The cloud creates and removes these managed profiles with bots.
Deleting a bot schedules removal of its profile directory. The bridge removes
that profile's sessions and run journals at startup, during hourly pruning,
or before serving a request for that slug, stopping active runs first. It
also detects a directory replaced under the same slug while it is running.
The agent's own conversation history remains in the shared `XDG_DATA_HOME`
at `/srv/hermes/data/acp-home/data`; bot deletion does not erase it. A reset
or uninstall with `--purge-data --i-understand-data-loss` removes it by deleting
`layout.RuntimeRoot` (`/srv/hermes/data`), even after engine state is gone.

It constructs none of the Hermes wiring. Provider, usage, model, toolset,
MCP, skills, memory, sessions, gateway restart and A2A administration routes
are absent. The bridge does not announce `approval_policy`; agent permission
requests go through the bridge to the user. All bots share the service account:
profile directories do not isolate bots from one another.

## Provider credentials

No installation or management command creates or updates
`/etc/hermes/opencode.env`. An administrator supplies that regular file,
owned by root:root with mode 0600. It uses the existing dotenv parser, without
shell evaluation. A missing file supplies no credentials. Values enter only
the child environment, never argv, the bridge process environment or logs.
Restarting the bridge loads an administrator's credential changes.

Accepted names are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `OPENCODE_API_KEY`,
`OPENROUTER_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` and `AWS_REGION`. Other names are refused, so credentials
cannot override loader or permission configuration. These are agent-owned
provider settings; openedbot cannot manage them through the ACP operator.

## Mandatory permission configuration

`/etc/hermes/opencode/opencode.json` is root:root 0644 in a root-owned 0755
directory. It contains:

```json
{
  "permission": "ask",
  "autoupdate": false,
  "share": "disabled"
}
```

The agent receives `OPENCODE_CONFIG` pointing to that file and
`OPENCODE_CONFIG_CONTENT` containing its root-read contents. The latter is
the documented inline override layer, after ordinary project configuration.
`OPENCODE_CONFIG_DIR` points to the root-controlled configuration directory.
`XDG_CONFIG_HOME` points to `/etc/hermes`, its parent, because OpenCode appends
`opencode` to that value. `HOME` points to its root-controlled `home` child;
XDG data, cache and state instead use the writable agent data directory.
`OPENCODE_DISABLE_PROJECT_CONFIG=true` disables project configuration discovery.
No `--auto` flag is passed. This prevents a writable profile configuration
from silently replacing the required permission setting.

Documentation consulted at the pinned release, rather than relying on the
changing website schema:

- [Permissions, v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/permissions.mdx):
  `permission: "ask"` requests approval for all operations. `edit` and `bash`
  are the specific file-write and command permissions.
- [Configuration, v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/config.mdx):
  `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`,
  `autoupdate` and `share`.
- [CLI environment, v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/cli.mdx):
  the configuration environment variables and the `acp` command.
- [Configuration loader, v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/config/config.ts)
  and [discovery paths](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/config/paths.ts):
  `OPENCODE_DISABLE_PROJECT_CONFIG`, inline precedence and configuration directory discovery.
- [Global paths, v1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/core/src/global.ts):
  OpenCode appends `opencode` to the XDG directories and creates them at startup.

The current public pages are [permissions](https://opencode.ai/docs/permissions/)
and [configuration](https://opencode.ai/docs/config/). They describe a newer
schema than the pinned release. Do not substitute their newer `permissions`
array for this release's `permission` key.

## Release pin and provenance

OpenCode v1.19.6, MIT, from the
[official release](https://github.com/anomalyco/opencode/releases/tag/v1.19.6).
The amd64 baseline build avoids requiring AVX2. Both SHA-256 digests below are
GitHub's official release asset `digest` fields, read on 2026-11-17 from
[the pinned release API](https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.19.6).
No locally calculated digest is represented as an upstream checksum.

| Go architecture | Official asset | SHA-256 |
|---|---|---|
| amd64 | [opencode-linux-x64-baseline.tar.gz](https://github.com/anomalyco/opencode/releases/download/v1.19.6/opencode-linux-x64-baseline.tar.gz) | `8443113b3f3dfebf8b0fa91c4377e5519a62b9231732d9344a5df001e4a852b3` |
| arm64 | [opencode-linux-arm64.tar.gz](https://github.com/anomalyco/opencode/releases/download/v1.19.6/opencode-linux-arm64.tar.gz) | `5b68c1f4c5e75b4134e664cc8f36d634d64208d4fcfe5bcf3b48bab699c2dbac` |

Exact command used to obtain the pin's official URLs and digests:

```sh
curl -fsSL https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.19.6 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["html_url"]); [print(a["name"],a.get("digest"),a["browser_download_url"]) for a in r["assets"] if a["name"] in ("opencode-linux-x64-baseline.tar.gz","opencode-linux-arm64.tar.gz")]'
```

`download.Client.Fetch` verifies the archive before extraction. Only its
regular `opencode` entry is installed, under a root-owned directory. The
installer proves `--version` as the service user before recording the pin.
Upgrade compares the installed pin and reinstalls changed pins, then restarts
and checks the bridge. No Hermes checkout, Python probe or reconciliation runs
on an ACP upgrade.

## Reset and uninstall

Both remove the bridge unit, agent directory, mandatory configuration and
tool state. Keeping data preserves the bearer, service account, profiles,
agent data, root-only bridge journal and `/etc/hermes/opencode.env`. Purging
removes them, using the existing explicit data-loss confirmation. ACP cleanup
does not reconcile Hermes or disable a rootless Docker runtime.

## Evidence and limits

Tests use the existing fake command runner, fake download transport, temporary
files and rendered unit goldens. They cover the ordered runtime install,
second-run bearer preservation, checksum refusal, changed-pin replacement,
engine state and switch gates, Linux-only selection, connector hello on the
wire, bridge/operator/connector unit rendering, doctor and upgrade runtime
selection, strict audit unit selection, reset keep/purge, and the bounded
profile-management capability and absent unrelated operator routes. Default
Hermes render goldens remain unchanged.

No real OpenCode agent was executed or installed. These tests do not prove
systemd namespace and credential mount behavior, runuser/PAM behavior inside
the sandbox, OpenCode JIT compatibility with the syscall filter, boot and
shutdown on a Linux host, real provider authentication, or a real OpenCode
file edit or shell request waiting for user approval. Those require a Linux
acceptance machine. No independent reviewer was spawned because this order
explicitly forbids delegation.
