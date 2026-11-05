package commands

import (
	"context"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"golang.org/x/mod/semver"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// elfMagic opens every Linux executable this tool can install.
var elfMagic = []byte{0x7f, 'E', 'L', 'F'}

var hexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// candidate is a verified binary ready to be installed.
type candidate struct {
	data []byte
	sum  string // lowercase hex SHA-256
	// version is the signed release the bytes come from; empty for --from.
	version string
}

// normalizeHex lowers and validates a 64-hex value given on the command
// line (a tag or a digest). Neither is a secret: they may travel in argv.
func normalizeHex(raw, flagName string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if !hexPattern.MatchString(v) {
		return "", fmt.Errorf("%s must be 64 hex characters, got %d", flagName, len(v))
	}
	return v, nil
}

// rejectsSha256Flag names the removed flag explicitly instead of letting the
// flag package answer "not defined": the operator must switch to --tag.
func rejectsSha256Flag(args []string) bool {
	for _, a := range args {
		if a == "--sha256" || a == "-sha256" || strings.HasPrefix(a, "--sha256=") || strings.HasPrefix(a, "-sha256=") {
			return true
		}
	}
	return false
}

// verifyCandidate refuses bytes whose digest differs from want or that are
// not an executable for the running platform.
func verifyCandidate(data []byte, want string) (candidate, error) {
	if got := selfupdate.Digest(data); got != want {
		return candidate{}, fmt.Errorf("sha256 mismatch: file is %s…, --sha256 says %s…", got[:12], want[:12])
	}
	if err := validateCandidateImage(data, runtime.GOOS, runtime.GOARCH); err != nil {
		return candidate{}, err
	}
	return candidate{data: data, sum: want}, nil
}

// verifyTaggedCandidate refuses bytes whose HMAC tag under the deployment
// key differs from tag, or that are not a native executable. The digest is
// computed here, never taken from the caller: the tag binds the bytes.
func verifyTaggedCandidate(data []byte, tag string, key []byte) (candidate, error) {
	sum := selfupdate.Digest(data)
	if !upgradeTagMatches(key, sum, tag) {
		return candidate{}, fmt.Errorf("tag mismatch: file sha256 %s… was not tagged with this host's deployment key (--tag %s…)", sum[:12], tag[:12])
	}
	return verifyCandidate(data, sum)
}

// fileCandidate reads an uploaded binary (capped) and verifies its tag.
func fileCandidate(path, tag string, key []byte) (candidate, error) {
	st, err := fsx.Lstat(path)
	if err != nil {
		return candidate{}, err
	}
	if !st.Exists {
		return candidate{}, fmt.Errorf("%s: no such file", path)
	}
	if !st.Regular {
		return candidate{}, fmt.Errorf("%s: %w", path, fsx.ErrNotRegular)
	}
	if st.Size > selfupdate.MaxBinarySize {
		return candidate{}, fmt.Errorf("%s: larger than %d bytes", path, selfupdate.MaxBinarySize)
	}
	f, err := os.Open(path)
	if err != nil {
		return candidate{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, selfupdate.MaxBinarySize))
	if err != nil {
		return candidate{}, err
	}
	return verifyTaggedCandidate(data, tag, key)
}

// releaseCandidate downloads a verified release from baseURL: version when
// given (its signature must come from exactly that tag), otherwise the one
// the base URL or its LATEST pointer names.
func releaseCandidate(ctx context.Context, baseURL, version string) (candidate, error) {
	rel, err := release(baseURL)
	if err != nil {
		return candidate{}, err
	}
	if version != "" {
		if rel, err = rel.Pin(version); err != nil {
			return candidate{}, err
		}
	}
	if rel, err = rel.Resolve(ctx); err != nil {
		return candidate{}, err
	}
	data, sum, err := rel.Download(ctx)
	if err != nil {
		return candidate{}, err
	}
	c, err := verifyCandidate(data, sum)
	c.version = rel.Version
	return c, err
}

// candidateVersion asks a verified candidate for its version: the bytes are
// written 0700 in dir, executed with `version`, and removed. The candidate
// has already passed the digest and source authentication checks and will be executed
// at --finish anyway; asking it first costs no trust.
func candidateVersion(ctx context.Context, dir string, data []byte, owner fsx.Owner) (string, error) {
	path := filepath.Join(dir, ".edge-setup.candidate")
	if err := fsx.WriteAtomic(path, data, 0o700, owner); err != nil {
		return "", err
	}
	defer os.Remove(path)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := osexec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return "", fmt.Errorf("candidate does not answer `version`: %v", err)
	}
	v := parseVersionOutput(string(out))
	if v == "" {
		return "", fmt.Errorf("candidate printed %q instead of a version", strings.TrimSpace(string(out)))
	}
	return v, nil
}

// describePattern reads what `git describe --tags --always --dirty` prints
// on a tagged tree: the tag, then optionally the commits since it and the
// abbreviated hash, then optionally -dirty.
var describePattern = regexp.MustCompile(`^(v[0-9]+\.[0-9]+\.[0-9]+)(?:-([0-9]+)-g[0-9a-f]{4,40})?(-dirty)?$`)

// compareToolVersions orders two tool versions and reports whether they can
// be ordered at all. A describe version counts as its tag plus the commits
// after it, so v0.3.0-1-gabc is newer than v0.3.0 and v0.3.0-dirty: semver
// alone reads both suffixes as pre-releases and compares them as text, which
// called a build one commit past the tag older than the tag. -dirty never
// orders anything. Other semver versions (v1.0.0-rc1) keep semver's order.
func compareToolVersions(a, b string) (int, bool) {
	ma, mb := describePattern.FindStringSubmatch(a), describePattern.FindStringSubmatch(b)
	if ma != nil && mb != nil {
		if c := semver.Compare(ma[1], mb[1]); c != 0 {
			return c, true
		}
		na, nb := describeAhead(ma[2]), describeAhead(mb[2])
		switch {
		case na < nb:
			return -1, true
		case na > nb:
			return 1, true
		}
		return 0, true
	}
	if !semver.IsValid(a) || !semver.IsValid(b) {
		return 0, false
	}
	// One side is a plain pre-release (v1.0.0-rc1): only its tag orders
	// against a describe version, and a commit past a tag beats the tag.
	if ma != nil {
		if c := semver.Compare(ma[1], b); c != 0 || ma[2] == "" {
			return c, true
		}
		return 1, true
	}
	if mb != nil {
		if c := semver.Compare(a, mb[1]); c != 0 || mb[2] == "" {
			return c, true
		}
		return -1, true
	}
	return semver.Compare(a, b), true
}

func describeAhead(raw string) int {
	n := 0
	for _, r := range raw {
		n = n*10 + int(r-'0')
		if n > 1<<20 {
			return 1 << 20
		}
	}
	return n
}

// isStableRelease is a published tag: vX.Y.Z, no pre-release, no build.
func isStableRelease(v string) bool {
	return semver.IsValid(v) && semver.Prerelease(v) == "" && semver.Build(v) == "" && semver.Canonical(v) == v
}

// refuseDowngrade compares two versions and refuses a strictly older
// candidate unless allowed. Versions that cannot be ordered (dev, a bare
// commit) are let through with a note.
func refuseDowngrade(installed, candidate string, allow bool) (note string, err error) {
	order, ok := compareToolVersions(candidate, installed)
	if !ok {
		return fmt.Sprintf("versions %q -> %q are not both semver: no downgrade check", installed, candidate), nil
	}
	if order < 0 && !allow {
		return "", fmt.Errorf("candidate %s is older than the installed %s; add --allow-downgrade to accept it (nothing was changed)", candidate, installed)
	}
	return "", nil
}

// checkReleaseCandidate guards the signed release path. The binary must
// claim the version its SHA256SUMS is signed for (a manifest signed on one
// tag never installs a binary of another), and that version must be strictly
// newer than the installed one. --allow-downgrade accepts an equal, older or
// unorderable installed version, but never relaxes the signature: the
// candidate is still the release of its own tag, verified for that tag.
func checkReleaseCandidate(installed, signed, claimed string, allowDowngrade bool) (note string, err error) {
	if !selfupdate.IsStableVersion(signed) {
		return "", fmt.Errorf("release %q is not a signed vX.Y.Z release (nothing was changed)", signed)
	}
	if claimed != signed {
		return "", fmt.Errorf("version mismatch: the binary claims %q but SHA256SUMS is signed for edge-setup/%s (nothing was changed)", claimed, signed)
	}
	order, ok := compareToolVersions(signed, installed)
	switch {
	case !ok && !allowDowngrade:
		return "", fmt.Errorf("installed version %q cannot be ordered against %s; add --allow-downgrade to install it anyway (nothing was changed)", installed, signed)
	case !ok:
		return fmt.Sprintf("installed version %q cannot be ordered against %s: installing it (--allow-downgrade)", installed, signed), nil
	case order == 0 && !allowDowngrade:
		return "", fmt.Errorf("%s is already the installed version; only a newer release is installed, add --allow-downgrade to reinstall it (nothing was changed)", signed)
	case order < 0 && !allowDowngrade:
		return "", fmt.Errorf("candidate %s is older than the installed %s; add --allow-downgrade to accept it (nothing was changed)", signed, installed)
	case order <= 0:
		return fmt.Sprintf("installing %s over %s (--allow-downgrade; signature verified for edge-setup/%s)", signed, installed, signed), nil
	}
	return "", nil
}

// upgradeTargets lists the paths that receive the candidate: the canonical
// installed path, plus the running executable when it lives elsewhere and
// is not the --from file itself (rewriting the source over itself would be
// pointless). Paths are compared after cleaning.
func upgradeTargets(installed, running, from string) []string {
	targets := []string{installed}
	if running == "" {
		return targets
	}
	running = filepath.Clean(running)
	if running == filepath.Clean(installed) {
		return targets
	}
	if from != "" && running == filepath.Clean(from) {
		return targets
	}
	return append(targets, running)
}

// pathCopies returns the conventional PATH copies of the tool that exist as
// regular files (a symlink to the installed path follows it on its own),
// minus the --from file and anything already targeted.
func pathCopies(candidates []string, from string, already []string, stat func(string) (fsx.Stat, error)) []string {
	seen := map[string]bool{}
	for _, p := range already {
		seen[filepath.Clean(p)] = true
	}
	if from != "" {
		seen[filepath.Clean(from)] = true
	}
	var out []string
	for _, p := range candidates {
		p = filepath.Clean(p)
		if seen[p] {
			continue
		}
		st, err := stat(p)
		if err != nil || !st.Exists || st.Symlink || !st.Regular {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// parseVersionOutput reads `edge-setup <version>` as printed by `version`.
// The currently installed binary asked here may still be a pre-rename
// hermes-setup release mid-upgrade, so its `hermes-setup <version>` output
// is accepted too.
func parseVersionOutput(out string) string {
	f := strings.Fields(out)
	if len(f) == 2 && (f[0] == "edge-setup" || f[0] == "hermes-setup") {
		return f[1]
	}
	return ""
}

// installedVersion asks the currently installed binary for its version, so
// the summary names what was really replaced even when the running process
// is already the new code.
func installedVersion(ctx context.Context, path string) string {
	if !fsx.Exists(path) {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := osexec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return ""
	}
	return parseVersionOutput(string(out))
}

// ensurePathLink keeps layout.ToolPathLink pointing at the installed binary
// (a regular file there, an operator's own copy, is left alone: pathCopies
// refreshes it; a symlink to another target is repointed), and forces the
// pre-rename names (layout.ToolLegacyPathLink, layout.ToolAliasPath) to be a
// symlink to it, so `hermes-setup status` still works after the edge-setup
// rename. Unlike ToolPathLink, a regular file at one of these two
// is never an operator's copy to preserve: it is this tool's own pre-rename
// binary (ToolInstallDir is tool-owned, and ToolLegacyPathLink shared the
// exact path the old ensurePathLink already managed as a symlink), so
// forceAliasAt replaces it rather than leaving it stale and unrefreshed.
func ensurePathLink() error {
	return ensurePathLinkIn(layout.ToolInstalledPath, layout.ToolAliasPath, layout.ToolPathLink, layout.ToolLegacyPathLink)
}

// ensurePathLinkIn is ensurePathLink on explicit paths. It first adopts an
// install made by a pre-rename binary: a v0.4.0 host upgrading itself to this
// release writes the new bytes to the pre-rename name (alias) and runs the
// finish step from there, so canonical does not exist yet. canonical then
// becomes a symlink to that file, which stays a regular file: a rollback by
// the old binary rewrites the same file, and every unit, which executes
// canonical, follows it. The next upgrade run by this code writes canonical
// as a regular file, and only then does forceAliasAt turn alias into a link.
func ensurePathLinkIn(canonical, alias, pathLink, legacyPathLink string) error {
	if err := adoptLegacyInstall(canonical, alias); err != nil {
		return err
	}
	if err := ensurePathLinkAt(pathLink, canonical); err != nil {
		return err
	}
	for _, link := range []string{legacyPathLink, alias} {
		if err := forceAliasAt(link, canonical); err != nil {
			return err
		}
	}
	return nil
}

// releaseAdoptedCanonical removes canonical when it is the link that
// adoptLegacyInstall made to alias, right before an install writes canonical
// as a regular file (WriteAtomic refuses to write through a link). alias, the
// running executable, is itself a target of that install.
func releaseAdoptedCanonical(canonical, alias string) error {
	st, err := fsx.Lstat(canonical)
	if err != nil || !st.Symlink {
		return err
	}
	if cur, err := os.Readlink(canonical); err != nil || cur != alias {
		return err
	}
	return os.Remove(canonical)
}

// adoptLegacyInstall links canonical to alias when nothing is at canonical
// and alias is a regular file (see ensurePathLinkIn).
func adoptLegacyInstall(canonical, alias string) error {
	cst, err := fsx.Lstat(canonical)
	if err != nil || cst.Exists {
		return err
	}
	ast, err := fsx.Lstat(alias)
	if err != nil || !ast.Exists || ast.Symlink || !ast.Regular {
		return err
	}
	return os.Symlink(alias, canonical)
}

// promotedCanonicalCopies extends the canonical PATH copies written this
// pass with a location that has nothing under the canonical name yet but
// does have a regular file under the pre-rename name (an install from
// before the edge-setup rename, e.g. the bootstrap's `install … /usr/local/sbin/hermes-setup`):
// the canonical file is created there too, so legacyAliasTargets/
// ensureLegacyPathAliases have something to alias the legacy name to,
// instead of leaving it a stale copy of the old binary that never upgrades
// again. already is the target list built so far (upgradeTargets +
// pathCopies), skipped to avoid a duplicate write.
func promotedCanonicalCopies(canonical, legacy, already []string, stat func(string) (fsx.Stat, error)) []string {
	seen := map[string]bool{}
	for _, p := range already {
		seen[filepath.Clean(p)] = true
	}
	var out []string
	for i, c := range canonical {
		c = filepath.Clean(c)
		if seen[c] {
			continue
		}
		if cst, err := stat(c); err == nil && cst.Exists {
			continue // already a symlink or a regular file: not a promotion
		}
		lst, err := stat(legacy[i])
		if err != nil || !lst.Exists || !lst.Regular {
			continue // nothing under the legacy name to promote
		}
		out = append(out, c)
	}
	return out
}

// legacyAliasTargets pairs each canonical PATH copy that exists as a regular
// file with its pre-rename alias name (same index in canonical/legacy):
// promotedCanonicalCopies creates the canonical file when only the legacy
// name held a regular copy, so by the time this runs (after Install) every
// location worth aliasing has a canonical regular file.
func legacyAliasTargets(canonical, legacy []string, stat func(string) (fsx.Stat, error)) map[string]string {
	links := map[string]string{}
	for i, c := range canonical {
		st, err := stat(c)
		if err != nil || !st.Exists || !st.Regular {
			continue
		}
		links[legacy[i]] = c
	}
	return links
}

// ensureLegacyPathAliases keeps each pre-rename PATH copy
// (layout.ToolLegacyPathCopies) as a symlink to its edge-setup sibling
// (layout.ToolPathCopies), so a script or a habit that still types
// hermes-setup keeps running the same build. forceAliasAt (not
// ensurePathLinkAt) converts a stale regular file left over from a
// pre-rename install rather than leaving it in place.
func ensureLegacyPathAliases() error {
	for link, target := range legacyAliasTargets(layout.ToolPathCopies, layout.ToolLegacyPathCopies, fsx.Lstat) {
		if err := forceAliasAt(link, target); err != nil {
			return err
		}
	}
	return nil
}

func ensurePathLinkAt(link, target string) error {
	st, err := fsx.Lstat(link)
	if err != nil {
		return err
	}
	if st.Exists && !st.Symlink {
		return nil
	}
	if st.Symlink {
		if cur, err := os.Readlink(link); err == nil && cur == target {
			return nil
		}
		if err := os.Remove(link); err != nil {
			return err
		}
	}
	return os.Symlink(target, link)
}

// forceAliasAt makes link a symlink to target unconditionally: unlike
// ensurePathLinkAt, an existing regular file there is replaced rather than
// left alone. Reserved for the edge-setup rename's legacy alias names, where a regular
// file is never an operator's own copy to preserve, only this tool's stale
// pre-rename binary left behind by an install that predates the rename.
func forceAliasAt(link, target string) error {
	st, err := fsx.Lstat(link)
	if err != nil {
		return err
	}
	if st.Exists {
		if st.Symlink {
			if cur, err := os.Readlink(link); err == nil && cur == target {
				return nil
			}
		} else {
			// A regular file is replaced only once target is a regular file
			// itself: until then it may be the only copy of the binary (an
			// install made by a pre-rename binary, see ensurePathLinkIn).
			tst, err := fsx.Lstat(target)
			if err != nil {
				return err
			}
			if !tst.Exists || tst.Symlink || !tst.Regular {
				return nil
			}
		}
		if err := os.Remove(link); err != nil {
			return err
		}
	}
	return os.Symlink(target, link)
}

// finishInline decides where the finish step runs: inline when the running
// executable already is the candidate (same digest), otherwise the installed
// binary must be re-executed so the finish runs in the new code.
func finishInline(runningSum, candidateSum string) bool {
	return runningSum != "" && runningSum == candidateSum
}

// upgradeInstall verifies an uploaded binary against its tag and installs it
// at the given paths. On refusal nothing is written.
func upgradeInstall(from, tag string, key []byte, owner fsx.Owner, paths ...string) (candidate, []string, error) {
	c, err := fileCandidate(from, tag, key)
	if err != nil {
		return candidate{}, nil, err
	}
	written, err := selfupdate.Install(c.data, owner, paths...)
	return c, written, err
}

func runUpgrade(env cli.Env, args []string) int {
	fs := newFlagSet("upgrade", env)
	yes := fs.Bool("yes", false, "confirm the mutation")
	from := fs.String("from", "", "install this binary (uploaded to the host) instead of the latest release; requires --tag")
	tag := fs.String("tag", "", "HMAC-SHA256 tag (hex) of the --from file under this host's deployment key (deploy-key set)")
	releaseURL := fs.String("release-url", "", releaseURLUsage)
	version := fs.String("version", "", "install this signed release (vX.Y.Z) instead of the one LATEST names")
	allowDowngrade := fs.Bool("allow-downgrade", false, "accept a release that is not newer than the installed version (still signed by its own tag)")
	dryRun := fs.Bool("dry-run", false, "verify the candidate (signature and SHA-256, or --tag) and print what would be replaced; change nothing")
	finish := fs.Bool("finish", false, "internal: run the finish step (units) in the already installed binary")
	previous := fs.String("previous", "", "internal: version that started the upgrade (with --finish)")
	auto := fs.Bool("auto", false, "internal: the pass of hermes-setup-upgrade.timer (newer published release only, proven or rolled back)")
	if rejectsSha256Flag(args) {
		return fail(env, cli.ExitUsage, "--sha256 was removed: a bare digest proves nothing about who built the file. Tag the upload with --tag (HMAC-SHA256 under the key installed by `edge-setup deploy-key set`); `make deploy` computes it")
	}
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "upgrade takes no positional argument")
	}
	if !*yes && !*dryRun {
		return fail(env, cli.ExitRefused, "upgrade replaces the installed binary and restarts its units; add --yes (nothing was changed)")
	}
	if *dryRun && (*auto || *finish) {
		return fail(env, cli.ExitUsage, "--dry-run does not combine with --auto or --finish")
	}
	if *from != "" && *releaseURL != "" {
		return fail(env, cli.ExitUsage, "--release-url only applies to the release path, not to --from")
	}
	if *auto && (*from != "" || *tag != "" || *finish || *allowDowngrade || *version != "") {
		return fail(env, cli.ExitUsage, "--auto takes the release path only: no --from, --tag, --finish, --allow-downgrade or --version")
	}
	if *version != "" {
		if *from != "" {
			return fail(env, cli.ExitUsage, "--version only applies to the release path, not to --from")
		}
		if !isStableRelease(*version) || !selfupdate.IsStableVersion(*version) {
			return fail(env, cli.ExitUsage, "--version must be vX.Y.Z, got %q", *version)
		}
	}
	if *releaseURL != "" {
		// Before root, the lock or a download: a refused base (plain http,
		// the retired GitHub repository) changes nothing.
		base, err := selfupdate.ParseBaseURL(*releaseURL)
		if err != nil {
			return fail(env, cli.ExitRefused, "upgrade: %v (nothing was changed)", err)
		}
		if *version != "" {
			if _, err := (selfupdate.Release{BaseURL: base}).Pin(*version); err != nil {
				return fail(env, cli.ExitUsage, "upgrade: %v (nothing was changed)", err)
			}
		}
	}
	if runtime.GOOS == "darwin" {
		return runMacUpgrade(env, macUpgradeOptions{From: *from, Tag: *tag, ReleaseURL: *releaseURL, Version: *version, AllowDowngrade: *allowDowngrade, Finish: *finish, Auto: *auto, Previous: *previous})
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	if !*finish && !*dryRun {
		unlock, err := lockUpgrade(layout.UpgradeLock)
		if err != nil {
			return fail(env, cli.ExitRefused, "upgrade: %v (nothing was changed)", err)
		}
		defer unlock()
	}
	if *auto {
		return runAutoUpgrade(env, *releaseURL)
	}
	g := guard.Default(runner)
	if fsx.Exists(g.Active()) || fsx.Exists(layout.ProxyActive) {
		return fail(env, cli.ExitRefused, "a transaction is active; wait for its commit or rollback before upgrading")
	}
	if *from == "" && *tag != "" {
		return fail(env, cli.ExitUsage, "--tag only applies to --from; the release path is verified by SHA256SUMS")
	}
	want := ""
	var deployKey []byte
	if *from != "" {
		if *tag == "" {
			return fail(env, cli.ExitUsage, "--from requires --tag <hex> (see `edge-setup deploy-key set` and `make deploy`)")
		}
		var err error
		if want, err = normalizeHex(*tag, "--tag"); err != nil {
			return fail(env, cli.ExitUsage, "%v", err)
		}
		var code int
		if deployKey, code = requireDeployKey(env, deployKeyPath); code != 0 {
			return code
		}
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()

	running, runningSum, err := selfupdate.SelfSHA256()
	if err != nil {
		return fail(env, cli.ExitFailure, "running executable: %v", err)
	}

	if *finish {
		if *from != "" {
			return fail(env, cli.ExitUsage, "--finish is internal and takes no source")
		}
		return finishUpgrade(ctx, env, *previous, runningSum, os.Getenv(finishModeEnv) == finishModeRollback)
	}

	var c candidate
	if *from != "" {
		src := *from
		if abs, err := filepath.Abs(src); err == nil {
			src = abs
		}
		if real, err := filepath.EvalSymlinks(src); err == nil {
			src = real
		}
		c, err = fileCandidate(src, want, deployKey)
		if err != nil {
			return fail(env, cli.ExitRefused, "upgrade --from: %v (nothing was changed)", err)
		}
		*from = src
	} else {
		c, err = releaseCandidate(ctx, *releaseURL, *version)
		if err != nil {
			return fail(env, cli.ExitFailure, "upgrade: %v", err)
		}
	}

	if *dryRun {
		return printUpgradeDryRun(env, c, running, *from)
	}
	if err := fsx.EnsureDir(layout.ToolInstallDir, 0o755, fsx.Root); err != nil {
		return fail(env, cli.ExitFailure, "upgrade: %v", err)
	}
	// Downgrade check on the verified candidate, before anything is written.
	installed := installedVersion(ctx, layout.ToolInstalledPath)
	if installed == "" {
		installed = env.Version
	}
	if !semver.IsValid(installed) {
		if st, err := state.Load(); err == nil && st != nil && semver.IsValid(st.ToolVersion) {
			installed = st.ToolVersion
		}
	}
	cand, err := candidateVersion(ctx, layout.ToolInstallDir, c.data, fsx.Root)
	if err != nil {
		return fail(env, cli.ExitRefused, "upgrade: %v (nothing was changed)", err)
	}
	var note string
	if *from != "" {
		// The deployment path (HMAC under this host's key) keeps its own
		// rule: an older build needs --allow-downgrade.
		note, err = refuseDowngrade(installed, cand, *allowDowngrade)
	} else {
		note, err = checkReleaseCandidate(installed, c.version, cand, *allowDowngrade)
	}
	if err != nil {
		return fail(env, cli.ExitRefused, "upgrade: %v", err)
	}
	if note != "" {
		printf(env.Stderr, "upgrade: %s", note)
	}
	targets := upgradeTargets(layout.ToolInstalledPath, running, *from)
	targets = append(targets, pathCopies(layout.ToolPathCopies, *from, targets, fsx.Lstat)...)
	targets = append(targets, promotedCanonicalCopies(layout.ToolPathCopies, layout.ToolLegacyPathCopies, targets, fsx.Lstat)...)
	// Read before the install overwrites it: the version really replaced.
	replaced := env.Version
	if finishInline(runningSum, c.sum) {
		if v := installedVersion(ctx, layout.ToolInstalledPath); v != "" {
			replaced = v
		}
	}
	// The binary being replaced is kept: a candidate that does not prove
	// itself (the proof of the automatic pass, gateway health included) is
	// put back, and the previous binary re-renders its own units.
	previousData, prevErr := readCapped(layout.ToolInstalledPath)
	canRollBack := prevErr == nil && selfupdate.Digest(previousData) != c.sum
	if canRollBack {
		if err := fsx.WriteAtomic(layout.ToolPreviousPath, previousData, 0o755, fsx.Root); err != nil {
			return fail(env, cli.ExitFailure, "upgrade: previous binary not kept: %v (nothing was changed)", err)
		}
	}
	install := func(data []byte) error {
		if err := releaseAdoptedCanonical(layout.ToolInstalledPath, layout.ToolAliasPath); err != nil {
			return err
		}
		if _, err := selfupdate.Install(data, fsx.Root, targets...); err != nil {
			return err
		}
		return ensureLegacyPathAliases()
	}
	sd := systemd.Client{Runner: runner}
	links := activeLinks(ctx, sd)
	since := time.Now()
	if err := install(c.data); err != nil {
		if canRollBack {
			if restore := install(previousData); restore != nil {
				return fail(env, cli.ExitFailure, "upgrade: %v; restoring %s failed: %v (previous binary kept at %s)", err, installed, restore, layout.ToolPreviousPath)
			}
		}
		return fail(env, cli.ExitFailure, "upgrade: %v; %s kept", err, installed)
	}

	// The finish step must run in the new code: inline when this process is
	// the candidate (make deploy runs the pushed binary), else re-exec the
	// installed binary. Both are proved, and rolled back the same way.
	if finishInline(runningSum, c.sum) {
		if code := finishUpgrade(ctx, env, replaced, c.sum, false); code != cli.ExitOK {
			err = fmt.Errorf("its finish step exited %d", code)
		}
	} else {
		err = runInstalledFinish(ctx, env, env.Version, false)
	}
	if err == nil {
		err = proveUpgrade(ctx, sd, since, cand, links, autoUpgradeProofTimeout, autoUpgradeSettle)
	}
	if err == nil {
		return cli.ExitOK
	}
	if !canRollBack {
		return fail(env, cli.ExitFailure, "upgrade: %s: %v", cand, err)
	}
	printf(env.Stderr, "upgrade: %s did not prove itself (%v); putting %s back", cand, err, installed)
	restore := install(previousData)
	if restore == nil {
		restore = runInstalledFinish(ctx, env, cand, true)
	}
	if restore == nil {
		restore = proveUpgrade(ctx, sd, time.Now(), installed, links, autoUpgradeProofTimeout, autoUpgradeSettle)
	}
	if restore != nil {
		return fail(env, cli.ExitFailure, "upgrade: %s rejected: %v; rollback to %s failed: %v (previous binary kept at %s)", cand, err, installed, restore, layout.ToolPreviousPath)
	}
	return fail(env, cli.ExitFailure, "upgrade: %s rejected: %v; %s restored and its links admitted again", cand, err, installed)
}

// finishUpgrade runs in the new binary: re-render the units that execute
// this tool, restart them, record the version, print the summary. rollback
// is set when this binary is the one put back after a rejected candidate
// (previous is then that candidate): the summary says so.
func finishUpgrade(ctx context.Context, env cli.Env, previous, sum string, rollback bool) int {
	if previous == "" {
		previous = "unknown"
	}
	sd := systemd.Client{Runner: runner}
	// Deliver the checkout repairs of this release to a host already
	// installed: `up` is the only command that touches the checkout, so a
	// host `up` refuses would otherwise never receive the fix for the very
	// reason it is refused. Offline and bounded; a failure is reported, and
	// never turns a delivered binary into a failed upgrade.
	if err := hermes.ReconcileCheckout(ctx, runner, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) }); err != nil {
		printf(env.Stdout, "  warning: managed Hermes checkout not reconciled: %v", err)
	}
	providerSDKs, probeErr := hermes.ProbeProviderSDKs(ctx, runner, layout.VenvBin+"/python")
	if probeErr != nil {
		printf(env.Stdout, "  warning: provider SDK probe failed: %v", probeErr)
	} else {
		printProviderSDKUpgradeNotice(env.Stdout, providerSDKs)
	}
	gatewayRestarted, err := reconcileUpgradeSecurityDefaults(ctx, runner, sd, waitGatewayHealthy,
		func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) })
	if err != nil {
		return fail(env, cli.ExitFailure, "upgrade: security defaults: %v", err)
	}
	connectorPath := "/etc/systemd/system/" + layout.ConnectorUnit + ".service"
	if fsx.Exists(connectorPath) {
		if err := installConnectorUnit(ctx, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) }); err != nil {
			return fail(env, cli.ExitFailure, "upgrade: %v", err)
		}
	}
	if err := ensurePathLink(); err != nil {
		return fail(env, cli.ExitFailure, "upgrade: %v", err)
	}
	// An enabled automatic upgrade gets the units of this binary; the reload
	// below picks them up.
	if _, timerPath := autoUpgradeUnitPaths(); fsx.Exists(timerPath) {
		if err := writeAutoUpgradeUnits(); err != nil {
			return fail(env, cli.ExitFailure, "upgrade: %v", err)
		}
	}
	// daemon-reload, enable --now, forced restart, connector try-restart. The
	// operator unit carries the same resolver exception as the connector units
	// rendered above, which announced it: read resolv.conf again, silently.
	_, connectorsRestarted, err := applyOperatorUnit(ctx, sd, true, egress.ResolverAllowFrom(layout.ResolvConf, "", nil))
	if err != nil {
		return fail(env, cli.ExitFailure, "upgrade: %v", err)
	}
	st, err := state.Load()
	if err != nil {
		return fail(env, cli.ExitFailure, "upgrade: state: %v", err)
	}
	// The gateway unit comes after the operator restart on purpose: the
	// « restart pending » marker it may set lives in the operator's
	// RuntimeDirectory, which exists once that unit has started. The unit
	// keeps the directory across restarts (RuntimeDirectoryPreserve=yes), so a
	// marker set earlier survives the restart above as well.
	gatewayUnit, err := reconcileGatewayUnit(ctx, sd, st, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) })
	if err != nil {
		return fail(env, cli.ExitFailure, "upgrade: gateway unit: %v", err)
	}
	if st != nil {
		st.ToolVersion = env.Version
		if err := st.Save(); err != nil {
			return fail(env, cli.ExitFailure, "upgrade: state: %v", err)
		}
		// Same reconciliation as reconcileUpgradeSecurityDefaults, for a
		// firewall selected before the loopback guard existed.
		if st.Features.Firewall {
			h := hardening.New(runner, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) })
			installed, err := h.EnsureLoopbackGuard(ctx)
			if err != nil {
				return fail(env, cli.ExitFailure, "upgrade: loopback guard: %v", err)
			}
			if installed {
				printf(env.Stdout, "  loopback guard installed: ports %v reserved for root and %s", hardening.LoopbackGuardPorts, layout.ServiceUser)
			}
			// A firewall enforced before the DNS exception existed denies the
			// resolver of a metadata-range host. Like the checkout, a failure is
			// reported and never turns a delivered binary into a failed upgrade.
			if _, err := h.EnsureResolverException(ctx); err != nil {
				printf(env.Stdout, "  warning: UFW DNS exception not restored: %v", err)
			}
		}
	}
	restarted := layout.OperatorUnit
	if gatewayRestarted || gatewayUnit.Outcome == gatewayUnitRestarted {
		restarted = layout.GatewayUnit + ", " + restarted
	}
	for _, unit := range connectorsRestarted {
		restarted += ", " + unit
	}
	short := sum
	if len(short) > 12 {
		short = short[:12]
	}
	printf(env.Stdout, "%s", finishSummary(previous, env.Version, short, rollback))
	printf(env.Stdout, "restarted %s", restarted)
	if gatewayUnit.Outcome == gatewayUnitPending {
		printf(env.Stdout, "restart pending: %s keeps its previous unit until it restarts; restart it from openedbot, or run `sudo systemctl restart %s` when no run is in progress", layout.GatewayUnit, layout.GatewayUnit)
	}
	printf(env.Stdout, `next: in openedbot, run "Tester" on the runtime so it re-reads /hermes-setup/capabilities`)
	return cli.ExitOK
}

func printProviderSDKUpgradeNotice(w io.Writer, statuses []hermes.ProviderSDKStatus) {
	notice := hermes.ProviderSDKNotice(statuses)
	if notice == "" {
		return
	}
	printf(w, "  %s", notice)
	for _, missing := range hermes.MissingProviderSDKs(statuses) {
		if slices.Contains(pins.HermesExtras, missing.Extra) {
			printf(w, "  run \"sudo edge-setup up\" to install: %s", missing.Label)
		}
	}
}

// reconcileUpgradeSecurityDefaults applies defaults introduced after an
// installation. It restarts the gateway only when a value changed and proves
// that restart on /health before the rest of the upgrade continues.
func reconcileUpgradeSecurityDefaults(ctx context.Context, r exec.Runner, sd systemd.Client, healthy func(context.Context) error, log func(string, ...any)) (bool, error) {
	changed, err := hermes.ApplySecurityDefaults(ctx, r, log)
	if err != nil {
		return false, err
	}
	// Re-read by Hermes on its file signature: it never forces the restart.
	if _, err := hermes.ApplyManagedDefaults(log); err != nil {
		return false, err
	}
	if !changed {
		return false, nil
	}
	if err := sd.Restart(ctx, layout.GatewayUnit); err != nil {
		return false, err
	}
	if healthy != nil {
		healthCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if err := healthy(healthCtx); err != nil {
			return true, err
		}
	}
	return true, nil
}

func init() {
	cli.Register(cli.Command{Name: "upgrade", Summary: "Replace the installed binary (verified release or --from file) and restart its units", Run: runUpgrade})
}

// printUpgradeDryRun reports a verified candidate and every path the upgrade
// would write, read from the host; it writes, locks and executes nothing
// (the candidate is not even asked for its version).
func printUpgradeDryRun(env cli.Env, c candidate, running, from string) int {
	source := "release " + c.version + " (signature and SHA-256 verified)"
	if from != "" {
		source = from + " (deployment tag verified)"
	}
	printf(env.Stdout, "dry run: %s, sha256 %s", source, c.sum)
	targets := upgradeTargets(layout.ToolInstalledPath, running, from)
	targets = append(targets, pathCopies(layout.ToolPathCopies, from, targets, fsx.Lstat)...)
	targets = append(targets, promotedCanonicalCopies(layout.ToolPathCopies, layout.ToolLegacyPathCopies, targets, fsx.Lstat)...)
	for _, t := range targets {
		printf(env.Stdout, "dry run: would replace %s (0755 root)", t)
	}
	printf(env.Stdout, "dry run: would then run `%s upgrade --yes --finish`: re-render and restart %s and every linked connector, keep the previous binary for a rollback", layout.ToolInstalledPath, layout.OperatorUnit)
	printf(env.Stdout, "dry run: nothing was changed")
	return cli.ExitOK
}

// runInstalledFinish runs `upgrade --finish` in the binary installed now, so
// the units are rendered by the code that will run them.
func runInstalledFinish(ctx context.Context, env cli.Env, previous string, rollback bool) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := finishCommand(ctx, layout.ToolInstalledPath, previous, rollback)
	cmd.Stdout, cmd.Stderr = env.Stdout, env.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s upgrade --finish: %w", layout.ToolInstalledPath, err)
	}
	return nil
}

// The finish step learns it runs a rollback from the environment, not from
// a flag: the binary put back may predate any new flag, and an unknown flag
// would fail the very rollback (an older binary ignores the variable and
// prints its own summary).
const (
	finishModeEnv      = "EDGE_SETUP_FINISH_MODE"
	finishModeRollback = "rollback"
)

// finishCommand is `upgrade --finish` in the binary at path, with the mode
// of the pass in its environment.
func finishCommand(ctx context.Context, path, previous string, rollback bool) *osexec.Cmd {
	cmd := osexec.CommandContext(ctx, path, "upgrade", "--yes", "--finish", "--previous", previous)
	cmd.Env = finishEnv(os.Environ(), rollback)
	return cmd
}

// finishEnv is the environment of the finish step: base without any
// inherited mode, plus the rollback mode when asked.
func finishEnv(base []string, rollback bool) []string {
	env := make([]string, 0, len(base)+1)
	for _, kv := range base {
		if !strings.HasPrefix(kv, finishModeEnv+"=") {
			env = append(env, kv)
		}
	}
	if rollback {
		env = append(env, finishModeEnv+"="+finishModeRollback)
	}
	return env
}

// finishSummary is the line the finish step ends on: from the version that
// started the pass to the one now installed.
func finishSummary(previous, version, short string, rollback bool) string {
	verb := "upgraded"
	if rollback {
		verb = "rolled back"
	}
	return fmt.Sprintf("%s edge-setup %s -> %s (sha256 %s)", verb, previous, version, short)
}
