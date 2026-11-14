# openedbot documentation

**Source of the openedbot documentation site, served at <https://docs.openedbot.app>.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](../LICENSE)
![Astro](https://img.shields.io/badge/Astro-7-BC52EE?logo=astro&logoColor=white)
![Starlight](https://img.shields.io/badge/Starlight-0.42-6E56CF)
![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)

## Overview

[openedbot](https://openedbot.app) is a cloud console that controls AI agents installed on your
own server. This site covers the console, the edge-setup installer and the operator reference.
It is built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build) as a
fully static site (`dist/`), bilingual: English by default under `/docs/`, French under
`/fr/docs/`, with the same file names.

## Where it fits

| Component | Role |
|---|---|
| **`docs/`** (this directory) | Documentation site and the `/install` script |
| [`apps/`](../README.md) | Console and API (AGPL-3.0 open core) |
| [`edge-setup/`](../edge-setup/README.md) | Binary installed on your server (Apache-2.0); its `make check-docs` reads this site |
| [`protocol/`](../protocol/README.md) | Public connector protocol (Apache-2.0) |
| [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | macOS notch UI prototype (its own repository) |

## Features

- `/`: home page (`src/pages/index.astro`)
- `/docs/<page>`: documentation pages (`src/content/docs/docs/<page>.mdx`). Code and packages
  link to these addresses (for example `https://docs.openedbot.app/docs/edge-setup`), so a file
  name never changes.
- `/install`: the edge-setup install script (see [below](#install-script))
- `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap-index.xml`, `/404`
- Full-text search (Pagefind) and a published scope that hides operator-only pages

## Requirements

- [Bun](https://bun.sh) only (never npm, yarn or pnpm)

## Quick start

```bash
bun install
bun run dev           # http://localhost:4321, DOCS_SCOPE=all by default
```

| Script | What it does |
|---|---|
| `bun run dev` | Dev server, `DOCS_SCOPE=all` by default |
| `bun run build` | Static build into `dist/`, `DOCS_SCOPE=public` by default |
| `bun run preview` | Serve `dist/` |
| `bun run check` | `astro check` (types) |
| `bun run check:links` | After a build: every internal link in `dist/` resolves |
| `bun run test` | `bun test` (see [Testing](#testing)) |

## Configuration

### `DOCS_SCOPE`

Read once, when the build or the dev server starts (`src/lib/docs-scope.ts`). Any other value
fails the build.

| Value | Pages built |
| --- | --- |
| `public` (default of `bun run build`) | The console guide (**Using openedbot**, **Help**) and the edge-setup page of **Reference** |
| `all` (default of `bun run dev`) | Every page, including the developer reference and the **In development** section, never public |

```bash
DOCS_SCOPE=public bun run build   # production
DOCS_SCOPE=all bun run build      # full operator reference
DOCS_SCOPE=public bun run dev     # preview the public scope
```

In `public`, a hidden page does not enter the content collection: it is not built, not in the
sidebar, the sitemap, the search or `llms.txt`. A link from a public page to a hidden page is
rendered as plain text (`src/lib/unlink-hidden-docs.ts`); the source keeps the link. The sidebar
order and sections are in `SIDEBAR_SECTIONS`, the public list in `PUBLIC_PAGES`. A new page must
be listed there, otherwise `tests/scope.test.ts` fails.

## Install script

`public/install` is the POSIX script served by
`curl -fsSL https://docs.openedbot.app/install | sh`. It downloads only from
`https://releases.openedbot.app/edge-setup`, checks the binary against the `SHA256SUMS` served
next to it, and never names `github.com`. `public/_headers` sets its headers
(`Content-Type: text/x-shellscript; charset=utf-8`, `X-Content-Type-Options: nosniff`,
`Cache-Control: public, max-age=300`).

## Contract with edge-setup

edge-setup's `internal/docs` test (`make check-docs`) reads the French pages of this site,
`src/content/docs/fr/docs` (the site is `docs/` at the monorepo root by default,
`OPENEDBOT_DOCS_DIR` otherwise):

- `operations.mdx` and `reset.mdx` reproduce edge-setup's `docs/OPERATIONS.md` and
  `docs/RESET.md`: every fenced code block is compared byte for byte after whitespace
  collapsing; numbered steps and sections (same title on both sides) are compared by their
  backtick spans;
- no page may repeat sentences that became false.

So never reformat a code block, a numbered list or a heading of those pages, and never rename a
file. A command change is made on both sides, in the same move.

## Testing

```bash
bun run test        # install script, _headers, scope, llms
bun run check       # types
bun run build && bun run check:links
```

`tests/install.test.ts` runs the install script in simulated environments (sha256sum or shasum,
managed destinations, root refusal, publication race, single origin) and checks `_headers`.

## Deployment

Cloudflare Worker `openedbot-docs` (`wrangler.toml`): the static assets of `dist/`, served to
everyone with no Worker code (`public/_headers` applies), on the custom domain
`docs.openedbot.app`, with no `workers.dev` alias.
`scripts/deploy.sh` checks types, tests and links, builds the `public` scope, deploys `dist/`,
then reads `/install` back from the public origin. The Cloudflare token stays in the
environment, never in an argument.

Redirects from the former site (`/docs/guarantees`, `/docs/modes`, `/docs/install`, …) are
static redirect pages declared in `astro.config.ts`.

## Project structure

```text
src/
  content/docs/   English (docs/) and French (fr/docs/) pages
  pages/          home, 404, llms.txt, llms-full.txt, robots.txt
  components/     landing and Starlight overrides
  lib/            docs scope, hidden-link unlinking, llms generation
  layouts/, styles/, assets/
public/           install script, _headers, static files
scripts/          link checker, deploy script
tests/            bun tests
```

## Documentation

The published site: <https://docs.openedbot.app>.

The `/hermes-setup/` routes quoted in the pages are technical identifiers kept for compatibility.

## License

Copyright 2026 Kévin Aubrée. Licensed under the [GNU Affero General Public License v3.0 only](../LICENSE),
like the openedbot core (see the root [`LICENSE`](../LICENSE)).
