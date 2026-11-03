package commands

import (
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
)

// releaseURLUsage documents the --release-url flag shared by self-verify,
// upgrade and update --self. A URL is not a secret, but it must be https.
const releaseURLUsage = "https base URL of the release assets (default: " + selfupdate.DefaultBaseURL + ")"

// release is the release source of self-verify, upgrade and the automatic
// pass: the public origin (or --release-url), Sigstore-verified. A variable
// so tests serve a local origin; nothing else replaces it.
var release = func(baseURL string) (selfupdate.Release, error) {
	a, _ := arch()
	return selfupdate.DefaultRelease(a.Go, baseURL)
}

func runSelfVerify(env cli.Env, args []string) int {
	fs := newFlagSet("self-verify", env)
	releaseURL := fs.String("release-url", "", releaseURLUsage)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "self-verify takes no positional argument")
	}
	rel, err := release(*releaseURL)
	if err != nil {
		return fail(env, cli.ExitRefused, "self-verify: %v", err)
	}
	// The binary is verified against the release of its own version, signed
	// by the release workflow on exactly that tag: never LATEST, never another
	// tag that happens to list the same bytes.
	if !selfupdate.IsStableVersion(env.Version) {
		return fail(env, cli.ExitRefused, "self-verify: this build (%s) is not a published vX.Y.Z release: there is no signed release to verify it against", env.Version)
	}
	if rel, err = rel.Pin(env.Version); err != nil {
		return fail(env, cli.ExitRefused, "self-verify: %v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	self, sum, err := selfupdate.SelfSHA256()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	printf(env.Stdout, "binary   %s\nversion  %s\nsha256   %s", self, env.Version, sum)
	rel, err = rel.Resolve(ctx)
	if err == nil {
		err = rel.Verify(ctx)
	}
	if err != nil {
		return fail(env, cli.ExitFailure, "release verification: %v", err)
	}
	printf(env.Stdout, "release  %s: signature verified for %s, binary listed in its SHA256SUMS", rel.Version, selfupdate.ReleaseIdentity(rel.Version))
	return cli.ExitOK
}

// runUpdate is `upgrade` behind the historical `update --self` spelling:
// `--self` is removed and every other flag reaches runUpgrade untouched, so
// the alias never silently drops --from, --sha256, --release-url or a gate.
func runUpdate(env cli.Env, args []string) int {
	self := false
	forward := make([]string, 0, len(args))
	for _, a := range args {
		if !self && (a == "--self" || a == "-self" || a == "--self=true") {
			self = true
			continue
		}
		forward = append(forward, a)
	}
	if !self {
		return fail(env, cli.ExitNotImpl, "update (re-apply pins) runs `up` again with the stored options: not implemented in this build; `update --self` is available")
	}
	return runUpgrade(env, forward)
}

func init() {
	cli.Register(cli.Command{Name: "self-verify", Summary: "Verify the binary against the signed release SHA256SUMS", ReadOnly: true, Run: runSelfVerify})
	cli.Register(cli.Command{Name: "update", Summary: "Re-apply pins, or --self to upgrade this binary (alias of upgrade)", Run: runUpdate})
}
