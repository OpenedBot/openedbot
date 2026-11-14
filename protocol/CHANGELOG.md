# Changelog

All notable changes to the openedbot connector protocol. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the specification
uses [semantic versioning](https://semver.org/) as described in
[SPEC.md](SPEC.md#versioning).

## [Unreleased]

### Added
- `GET /hermes-setup/profiles`: an MCP server described by a mapping entry of
  the profile's `mcp_servers` also carries `endpoint` (or nothing), `auth`
  (`oauth`, `header` or `none`, reduced as in the root MCP inventory) and, for
  an `oauth` server, `oauthTokenPresent`: whether the PROFILE holds a token
  for it (never its content), asked of the same upstream token storage as the
  root under the profile's home and checked against its
  `mcp-tokens/<server>.json`; `false` also covers an empty or non-regular
  file; omitted when the two disagree or the check fails. A non-mapping entry
  keeps name and state only. Each profile whose entries were described
  carries `mcpFacts: true`, so an empty list means no server. Carrying an
  entry proves nothing: a profile is cloned from the root config and the
  per-profile MCP switch copies the root entry, both without a token. A host
  without these fields says nothing: openedbot reads them as unknown, and
  keeps only the public form of `endpoint`.
- MCP OAuth session view: `profile` (string, or `null` for the runtime root)
  names whose home receives the token. The 409 `MCP_OAUTH_IN_PROGRESS` of
  `POST …/{server}/oauth` returns the pending authorization of the server,
  whatever its profile: openedbot takes it as its own only when `profile`
  is the one it asked for, and treats a session without the field (older
  host) as a conflict.
- `POST …/{server}/oauth/callback` answers 400 `OAUTH_CALLBACK_INVALID` when
  `state` is not the one of the pending authorization URL, and 409
  `OAUTH_CALLBACK_USED` (documented, never emitted until now) when that
  `state` was already relayed, even after the authorization ended. Both used
  to answer 200 with the pending session. An error callback is held to the
  same rule: openedbot relays `{"error", "state"}`, and an error without the
  pending state is refused instead of failing the authorization.
- MCP OAuth session view: `callbackReceived` (bool). Once the provider's
  callback reached the program, `DELETE …/oauth/{session}` answers 409
  `OAUTH_CALLBACK_RECEIVED` instead of undoing an approval that is
  completing. A host without the field accepts any cancel: openedbot then
  never cancels a session on its own.
- `errorCode` `OAUTH_SAVE_TIMEOUT`: the program kept the configuration lock
  past its one-minute bound; the operator took it back and stopped it.
- `POST /v1/runs/{id}/resolve-unknown` joins the relay allowlist (Hermes 0.23):
  it closes a run its process lost mid-turn, with exactly
  `{admission_id, execution_generation}`. A Hermes 0.22 host never needs it.
- Host feature `auto_upgrade`: a state, not a route. The host's automatic
  upgrade timer is enabled, so a newer edge-setup release installs itself.
  The connector reads the operator again every 5 minutes during a session and
  sends `capabilities` only when the list changed, so the feature appears or
  vanishes without a reconnection.

### Changed
- SPEC.md is regenerated from the host reference again, with no change to the
  wire protocol or to either implementation. The text now documents what both
  sides already do: the self-retirement frames `link.retire` / `link.retired`
  (kept from the previous text and restored in the host reference), the
  per-profile route `GET /hermes-setup/profiles/{slug}/workspace/files/{file}`,
  a profile's Tool Search setting, the partial read-cache invalidation of
  profile-only writes, the single-process toolsets batch, the resumption of an
  unfinished run journal, and the refusal to link a second instance to an
  origin another instance already links.
- Approval gates of openedbot's own MCP tools (`openedbot_routines/routine_manage`,
  `openedbot_bot_settings/bot_settings_propose`) no longer carry `run_key` in
  the `openedbot-gate/v1` descriptor. A `routine_manage` call whose `action`
  is exactly `list` raises no gate (unless the tool is in `blockedTools`);
  every other call, or one the plugin cannot read, still does. When a
  `routine_manage` descriptor exceeds 1 KiB, `prompt` gives way to
  `prompt_chars` (its length in Unicode code points) and the descriptor is
  `opaque`. openedbot drops `run_key` from a gate sent by an older host on its
  own. Descriptor version unchanged.
- `POST /hermes-setup/mcp/servers` reserves server names starting with
  `openedbot_`: such a name must point, over https, at openedbot's own route
  for it (`/api/mcp/routines/<uuid>`, `/api/mcp/bot-settings/<uuid>`), else
  400 `NAME_RESERVED`.
- `hello.hermesVersion` is the Hermes version installed on the host, omitted
  when the host cannot read it. edge-setup used to send the version its binary
  pins, so a host upgraded without reinstalling Hermes hid the pending Hermes
  update.
- `capabilities` replaces the operator features only: the link features
  announced in `hello` (`creation_audit_v2`) stay for the session. openedbot
  used to drop them from the stored list on the first `capabilities` frame.
- The reference package is named `@openedbot/protocol-connector` and is the
  source of truth: the monorepo's `@openedbot/contracts-connector` re-exports
  it instead of carrying a copy, and `scripts/sync-from-siblings.sh` no
  longer copies the codec (only tests, golden files and the spec body).
- **Breaking.** A `hello` whose `devicePublicKey` differs from the key
  registered for the runtime is closed `4401` `LINK_POP_FAILED` before any
  `link.challenge`, under the current token as under a previous one, and
  journaled `pop_failed` with reason `rekey_refused`. openedbot used to
  register the new key after a proof made with that same key, which a stolen
  link token was enough to pass. A host gets a new key only through a new
  enrollment; a runtime with no registered key still registers its first one
  under the current token.
- **Breaking.** `link.context` carries the public origin as `openedbot`
  (was the product's former short name). The proof of possession signs a
  message prefixed `openedbot-link-pop/v1`, and the creation audit file is
  sealed with the magic `OBAUDIT2` and keys derived for
  `openedbot-creation-audit/v2`: a host and an openedbot from before this
  change no longer link, and an older audit file no longer opens.
- Provider usage probe: `xai-oauth` joins the fixed providers (`anthropic`,
  `openai-codex`, `openrouter`); its quotas are read from xAI, Hermes does not
  report them.

### Added
- Request header `traceparent` (W3C Trace Context, version `00`), optional
  both ways: openedbot sets it on every request of a run (trace id = the run
  id without dashes, a new span id per request); a host that knows it
  journals `relay <METHOD> <path> trace=<id> span=<id>` once the route passed
  the allowlist and relays the value unchanged to the gateway; a malformed or
  duplicated one is dropped, neither relayed nor journaled. An older host
  drops it like any header outside the list, an older openedbot never sends
  it: the request is served the same either way. `RELAY_TRACEPARENT_HEADER`
  joins `RELAY_FORWARDED_REQUEST_HEADERS`.
- `connector/src/relay-features.ts`: every feature name a host may announce,
  as constants, plus `RELAY_HOST_FEATURES` (the host's priority order, the
  same as edge-setup's `HostFeatures`) and `RELAY_LINK_FEATURES`
  (`LinkFeatures`). A monorepo test reads the Go list and fails when the two
  differ by a name or by their order. 21 names that only lived in openedbot's
  application code are now listed here; no name changed.
- `inventory.changed` (host → openedbot, no field): the host's inventory files
  moved, or a session starts. Sent only when `link.context.accepts` names it.
- `link.context.accepts`: the optional host frames this openedbot understands
  (at most 16 frame types). Older hosts ignore the field.
- Vectors for both.
- Host feature `skills_inventory` and host route `GET /hermes-setup/skills`:
  the root skills read by the host operator, same shape as `/v1/skills`. A
  fallback for Hermes builds whose `/v1/skills` fails.
- Host feature `profile_toolsets_batch` and host route
  `POST /hermes-setup/profiles/{slug}/toolsets`: several toolsets of one
  profile in one write (one process for both directions on the host), one
  read-back state per name. Without it openedbot writes them one request at
  a time.
- `POST /hermes-setup/profiles` accepts `bundledSkills: false` and answers the
  bundled-skills state when the creation turned them off. A host that ignores
  the field answers without it; openedbot then writes them through
  `POST /hermes-setup/profiles/{slug}/bundled-skills`.
- Host route `GET /hermes-setup/workspace/files/{file}` in the reference
  allowlist and its vectors: one bounded file name (png, jpg, jpeg, webp, pdf)
  at the root of the bots' `/workspace`, never a path, without the `/p/{slug}`
  prefix or a query. The cloud and edge-setup already served it; a host built
  on the previous reference refused the media downloads openedbot asks for.

### Changed
- `RELAY_STAGE_HEADER` is `X-OpenedBot-Relay-Stage`, and `relayStageOf` reads
  only that name: `LEGACY_RELAY_STAGE_HEADER` is removed. Hosts never read or
  set this header.

## [1.0.0] - 2026-10-28

First versioned release of the specification. Wire protocol `1`.

### Added
- Version table and versioning rules at the top of `SPEC.md`.
- Normative test vectors in `connector/fixtures/` (relay frames and gateway
  route allowlist), identical to the ones in edge-setup `test/golden/`.
- Self-contained TypeScript package: `bun install && bun run check` type-checks
  the codec and runs the vector, allowlist and fixture-schema tests.
- `scripts/sync-from-siblings.sh` to refresh sources, tests, vectors and the
  spec body from the two reference implementations.

### Changed
- Spec body and codec synced with the current implementations (product name
  openedbot, current frame set and allowlist).
- `isUuid` is vendored in `connector/src/uuid.ts`; the package no longer
  depends on a workspace package.
