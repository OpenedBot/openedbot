# openedbot-protocol

**The versioned wire contract between openedbot and the connector that runs next to your agents.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Spec](https://img.shields.io/badge/spec-1.0.0-informational)
![Wire protocol](https://img.shields.io/badge/wire%20protocol-1-informational)
![TypeScript](https://img.shields.io/badge/TypeScript-reference%20codec-3178C6?logo=typescript&logoColor=white)

## Overview

[openedbot](https://openedbot.app) is the cloud console that drives AI agents running on your own
servers. This repository specifies how a host links to that cloud over **one outbound
WebSocket**, which frames may cross the link, and exactly which gateway routes the cloud may
reach on your host. Anything outside the allowlist is refused on the host, before it reaches the
agent runtime.

edge-setup is the reference host implementation (Go, with the Hermes agent). Any third-party
agent or gateway can link to openedbot by implementing this specification.

## Where it fits

| Component | Role |
|---|---|
| **openedbot-protocol** (this repo) | Specification, reference TypeScript codec and normative test vectors |
| edge-setup | Host-side implementation (Go): installer and connector |
| openedbot-main | Cloud-side implementation (TypeScript): API and link gateway |
| [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | macOS notch UI prototype for openedbot |

## Features

- **Specification**: [SPEC.md](SPEC.md), version **1.0.0**, wire protocol `1`: link lifecycle,
  enrollment, relay frames, limits, close codes, route allowlist, operator verbs, proof of
  possession, announced origin change
- **Reference codec**: strict relay frame decoder/encoder (`relay-frames.ts`), gateway route
  allowlist (`relay-allowlist.ts`) and A2A agent card types (`a2a.ts`)
- **Normative test vectors**: byte-identical to the host implementation's golden files
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## Requirements

- [Bun](https://bun.sh) 1.3 or later
- TypeScript 5.9 (installed as a dev dependency)

## Quick start

```bash
bun install
bun run check        # typecheck + tests
```

Use the codec from another Bun or TypeScript project:

```ts
import { decodeTextFrame, matchRelayRoute, RELAY_PROTOCOL } from "@openedbot/contracts-connector";

const frame = decodeTextFrame(raw);          // throws RelayFrameError on any invalid frame
const route = matchRelayRoute("GET", "/health");
```

`@openedbot/contracts-connector`, the `/hermes-setup/` routes and the `X-OpenedBot-Relay-Stage` header are
technical identifiers kept for wire compatibility.

## Implementing the protocol

1. Read [SPEC.md](SPEC.md). The normative body is currently in French; an English translation is
   planned. In case of doubt, the test vectors are authoritative.
2. Run your decoder against `connector/fixtures/relay-frames.vectors.json`: every `valid: true`
   frame must be accepted and every `valid: false` frame refused.
3. Check your router against `connector/fixtures/relay-allowlist.json`.

## Testing

| Script | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit -p connector/tsconfig.json` |
| `bun run test` | `bun test connector/tests`: every vector, every allowlist case, fixture schemas, spec consistency |
| `bun run check` | Both of the above |
| `bun run sync` | Refresh the spec and fixtures from the two reference implementations checked out next to this repo |

## Project structure

```text
SPEC.md               the specification
CHANGELOG.md          protocol changes
connector/
  src/                reference codec, allowlist, A2A types
  fixtures/           normative test vectors
  tests/              tests over the vectors and the spec
scripts/              sync from the reference implementations
```

## Status

The two reference implementations are still where the contract is developed; this repository is
refreshed from them with `bun run sync` and versioned on its own. Making it the single source both
sides import is planned.

## Documentation

- Specification: [SPEC.md](SPEC.md)
- Product documentation: <https://docs.openedbot.app>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a
public issue.

## License

Copyright 2026 Kévin Aubrée. Licensed under the [Apache License, Version 2.0](LICENSE).
