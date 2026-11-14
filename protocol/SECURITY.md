# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem in the protocol
or in this package.

Report it privately through GitHub Security Advisories: open the repository
**Security** tab and click **Report a vulnerability**
(<https://github.com/OpenedBot/openedbot/security/advisories/new>).

Include the spec version (top of `SPEC.md`), the frames or routes involved, a
reproduction (ideally a new test vector) and the impact. Never include a real
link token, enrollment ticket, gateway bearer or provider key; redact them.

We aim to acknowledge a report within 3 business days and to agree on a fix
and disclosure timeline with you. Reporters are credited in the advisory
unless they prefer otherwise.

## Scope

In scope: the specification itself (a frame, field or route that lets a
hostile cloud reach more of a host than the allowlist permits, or a hostile
host impersonate another), the reference codec and allowlist in `connector/`,
and the test vectors. Implementation bugs in edge-setup should be reported on
that repository; they are fixed in both places when the contract is affected.

## Supported versions

Only the latest specification version receives fixes.
