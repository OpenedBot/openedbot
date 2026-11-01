# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub Security Advisories: open the repository
**Security** tab and click **Report a vulnerability**
(<https://github.com/OpenedBot/openedbot/security/advisories/new>).

Include:

- the version (`edge-setup version`) and the host OS / architecture;
- the steps to reproduce and the impact you observed;
- never a real enrollment ticket, link token, gateway bearer, provider key or
  password. Redact them.

We aim to acknowledge a report within 3 business days and to agree on a fix
and disclosure timeline with you. We credit reporters in the advisory unless
you prefer otherwise.

## Supported versions

Only the latest `vX.Y.Z` release published on
`https://releases.openedbot.app/edge-setup` receives security fixes. Upgrade
with `sudo edge-setup upgrade --yes` (or enable `auto-upgrade`).

## Scope

In scope: this binary, the systemd units and files it renders, the connector
link and its frame validation, the operator verbs, the install bootstrap
served at `https://docs.openedbot.app/install`, and release verification.

The threat model, what the installer does to a host, and how to verify a
release signature by hand are in
[`../docs/edge-setup-security.md`](../docs/edge-setup-security.md); the trust
boundary is also on the Trust page of the documentation
(`https://docs.openedbot.app/docs/confiance`), and the link in
[`docs/CONNECTOR.md`](docs/CONNECTOR.md).

## Release trust model

Each release publishes, under the immutable
`https://releases.openedbot.app/edge-setup/vX.Y.Z/`, the binaries, the
bootstrap script, a `SHA256SUMS` file and a Sigstore bundle for each of them.
Releases are signed keyless in CI: the release workflow
`.github/workflows/edge-setup-release.yml`, run on the tag `edge-setup/vX.Y.Z`,
signs through GitHub OIDC and the signature is logged in Sigstore's public
transparency log. There is no long-lived signing key.

The bootstrap, `upgrade`, `auto-upgrade` and `self-verify` accept only the
certificate identity
`https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/vX.Y.Z`
for version `vX.Y.Z`, issued by `https://token.actions.githubusercontent.com`,
compared exactly (no prefix, no pattern). The version is the one asked for,
the installed one for `self-verify`, or `LATEST` read once, and the binary
must claim that same version. `upgrade` and `auto-upgrade` install only a
strictly newer version; `upgrade --allow-downgrade` allows the same or an
older one, still signed for its own tag, and `auto-upgrade` never goes back.
They verify the signature of `SHA256SUMS` first, then the binary's SHA-256
against it, and execute or install nothing before both checks pass. A release
without a signature (every release up to v0.0.2) is refused, and there is no
fallback to another origin. The bootstrap installs the version it pins unless
another one, or `latest`, is asked for explicitly.

Inside the trust boundary: the GitHub repository and its release workflow on a
release tag, GitHub's OIDC issuer, and the Sigstore public-good instance
(Fulcio, Rekor and its TUF trusted root). A compromise of the release origin
alone (`releases.openedbot.app`) can withhold releases or point `LATEST` at an
older signed one (`upgrade` refuses the same or an older version without
`--allow-downgrade`), but cannot serve a binary that verifies. The bootstrap
piped from `https://docs.openedbot.app/install` is trusted over HTTPS when it
runs; the same script ships signed in each release as `install.sh`, with its
own bundle, for an operator who verifies it before running it.
