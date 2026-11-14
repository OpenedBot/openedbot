# Security policy

## Reporting a vulnerability

Please **do not open a public issue, discussion or pull request** for a
security problem.

Report it privately through GitHub Security Advisories: open the repository
**Security** tab and click **Report a vulnerability**
(<https://github.com/OpenedBot/openedbot/security/advisories/new>).

Include:

- the component (for example `edge-setup`, the API, the console, the
  connector protocol) and its version or commit;
- the steps to reproduce and the impact you observed;
- never a real credential: enrollment ticket, link token, gateway bearer,
  API or provider key, password, session cookie. Redact them.

We aim to acknowledge a report within 3 business days and to agree on a fix
and disclosure timeline with you. We credit reporters in the advisory unless
you prefer otherwise.

## Supported versions

Security fixes land on `main`. For `edge-setup`, only the latest `vX.Y.Z`
release published on `https://releases.openedbot.app/edge-setup` receives
them: upgrade with `sudo edge-setup upgrade --yes`.

## Component policies

- `edge-setup`, the host installer and connector: [`edge-setup/SECURITY.md`](edge-setup/SECURITY.md)
  (scope and release trust model) and
  [`docs/edge-setup-security.md`](docs/edge-setup-security.md) (threat model,
  what the installer does to a host, how to verify a release signature by
  hand).
- The connector link protocol: [`protocol/SPEC.md`](protocol/SPEC.md).

## Secrets in this repository

Pull requests and pushes to `main` are scanned by gitleaks
(`.github/workflows/gitleaks.yml`, allowlist of reviewed test fixtures in
`.gitleaks.toml`). If you find a live credential in the history, report it as
a vulnerability, not in a public issue.
