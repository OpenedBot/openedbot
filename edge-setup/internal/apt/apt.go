// Package apt wraps apt-get and dpkg with the two disciplines the tool
// needs: never start a service from a postinst (policy-rc.d 101 while
// installing), and prove a pinned version exists before installing it.
package apt

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const (
	aptGet     = "/usr/bin/apt-get"
	aptCache   = "/usr/bin/apt-cache"
	aptMark    = "/usr/bin/apt-mark"
	dpkgQuery  = "/usr/bin/dpkg-query"
	policyRcD  = "/usr/sbin/policy-rc.d"
	policyBody = "#!/bin/sh\n# Installed by edge-setup for the duration of one apt run.\nexit 101\n"
)

// Client runs apt.
type Client struct {
	Runner exec.Runner
	// PolicyRcD overrides the path (tests).
	PolicyRcD string
}

// New returns a client.
func New(r exec.Runner) Client { return Client{Runner: r, PolicyRcD: policyRcD} }

func (c Client) env() []string {
	return []string{"DEBIAN_FRONTEND=noninteractive", "LC_ALL=C", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
}

// Update refreshes the index.
func (c Client) Update(ctx context.Context) error {
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: []string{"update"}, Env: c.env()})
	return err
}

// Install installs packages (or exact `name=version` selections) without
// letting a postinst start any unit.
func (c Client) Install(ctx context.Context, pkgs ...string) error {
	if len(pkgs) == 0 {
		return nil
	}
	return c.withoutServiceStarts(func() error {
		args := append([]string{"install", "-y", "--no-install-recommends"}, pkgs...)
		_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: args, Env: c.env()})
		return err
	})
}

// InstallHeld installs exact `name=version` selections and holds them, so no
// later `apt-get upgrade` carries them past their pin. The install itself may
// change a held package: that is how a pin bump lands.
func (c Client) InstallHeld(ctx context.Context, selections ...string) error {
	if len(selections) == 0 {
		return nil
	}
	err := c.withoutServiceStarts(func() error {
		args := append([]string{"install", "-y", "--no-install-recommends", "--allow-change-held-packages"}, selections...)
		_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: args, Env: c.env()})
		return err
	})
	if err != nil {
		return err
	}
	names := make([]string, 0, len(selections))
	for _, s := range selections {
		name, _, _ := strings.Cut(s, "=")
		names = append(names, name)
	}
	return c.Hold(ctx, names...)
}

// Hold marks packages held; holding a held package is a no-op.
func (c Client) Hold(ctx context.Context, pkgs ...string) error {
	return c.mark(ctx, "hold", pkgs)
}

// Unhold releases holds placed by Hold.
func (c Client) Unhold(ctx context.Context, pkgs ...string) error {
	return c.mark(ctx, "unhold", pkgs)
}

func (c Client) mark(ctx context.Context, verb string, pkgs []string) error {
	if len(pkgs) == 0 {
		return nil
	}
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptMark, Args: append([]string{verb}, pkgs...), Env: c.env()})
	return err
}

// UpgradeSafe applies available upgrades without removing packages. The
// installed packages among pinned are held first, so the upgrade leaves them
// at their pin even on a host whose install predates the holds.
func (c Client) UpgradeSafe(ctx context.Context, pinned ...string) error {
	if err := c.Update(ctx); err != nil {
		return err
	}
	var installed []string
	for _, p := range pinned {
		v, err := c.InstalledVersion(ctx, p)
		if err != nil {
			return err
		}
		if v != "" {
			installed = append(installed, p)
		}
	}
	if err := c.Hold(ctx, installed...); err != nil {
		return err
	}
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: []string{"upgrade", "-y", "--no-install-recommends"}, Env: c.env()})
	return err
}

// Purge removes packages with their configuration.
func (c Client) Purge(ctx context.Context, pkgs ...string) error {
	if len(pkgs) == 0 {
		return nil
	}
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: append([]string{"purge", "-y"}, pkgs...), Env: c.env()})
	return err
}

// withoutServiceStarts installs policy-rc.d (exit 101) for the duration of fn
// unless one already exists, and always removes the one it installed.
func (c Client) withoutServiceStarts(fn func() error) error {
	installed := false
	if !fsx.Exists(c.PolicyRcD) {
		if err := fsx.WriteAtomic(c.PolicyRcD, []byte(policyBody), 0o755, fsx.Current()); err != nil {
			return err
		}
		installed = true
	}
	defer func() {
		if installed {
			_ = os.Remove(c.PolicyRcD)
		}
	}()
	return fn()
}

// PolicyOffers reports whether `apt-cache policy` lists the exact version
// for the package, proving the repository provides the pin.
func (c Client) PolicyOffers(ctx context.Context, pkg, version string) (bool, error) {
	out, err := exec.Output(ctx, c.Runner, aptCache, "policy", pkg)
	if err != nil {
		return false, err
	}
	return PolicyLists(out, version), nil
}

// PolicyLists parses `apt-cache policy` output for an exact version entry.
func PolicyLists(policyOutput, version string) bool {
	for _, line := range strings.Split(policyOutput, "\n") {
		fields := strings.Fields(line)
		// Version table entries look like "     5:29.7.2-1~debian.13~trixie 500" or "*** 5:29… 500".
		for _, f := range fields {
			if f == version {
				return true
			}
		}
	}
	return false
}

// InstalledVersion returns the installed version of a package, or "" if not
// installed.
func (c Client) InstalledVersion(ctx context.Context, pkg string) (string, error) {
	res, err := c.Runner.Run(ctx, exec.Cmd{Path: dpkgQuery, Args: []string{"-W", "-f=${Status}\t${Version}\n", pkg}})
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", nil
	}
	status, version, _ := strings.Cut(strings.TrimSpace(res.Stdout), "\t")
	if !strings.HasSuffix(status, " installed") {
		return "", nil
	}
	return version, nil
}

// ConffileMD5 returns the packaged md5 of a conffile from dpkg's database.
func (c Client) ConffileMD5(ctx context.Context, pkg, conffile string) (string, error) {
	out, err := exec.Output(ctx, c.Runner, dpkgQuery, "-W", "-f=${Conffiles}\n", pkg)
	if err != nil {
		return "", err
	}
	return ConffileMD5From(out, conffile), nil
}

var md5Re = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ConffileMD5From parses the ${Conffiles} listing.
func ConffileMD5From(listing, conffile string) string {
	for _, line := range strings.Split(listing, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == conffile && md5Re.MatchString(f[1]) {
			return f[1]
		}
	}
	return ""
}

// KeyFingerprints runs gpg --show-keys on an armored keyring and returns the
// fingerprints found.
func (c Client) KeyFingerprints(ctx context.Context, keyring string) ([]string, error) {
	out, err := exec.Output(ctx, c.Runner, "/usr/bin/gpg", "--show-keys", "--with-colons", "--fingerprint", keyring)
	if err != nil {
		return nil, err
	}
	return FingerprintsFrom(out), nil
}

// FingerprintsFrom parses gpg --with-colons output for fpr records.
func FingerprintsFrom(colons string) []string {
	var out []string
	for _, line := range strings.Split(colons, "\n") {
		f := strings.Split(line, ":")
		if len(f) > 9 && f[0] == "fpr" {
			out = append(out, f[9])
		}
	}
	return out
}

// Require fails unless every pinned selection is offered by the repository.
func (c Client) Require(ctx context.Context, selections ...string) error {
	for _, s := range selections {
		pkg, version, ok := strings.Cut(s, "=")
		if !ok {
			continue
		}
		offered, err := c.PolicyOffers(ctx, pkg, version)
		if err != nil {
			return err
		}
		if !offered {
			return fmt.Errorf("%s=%s is not offered by the configured repositories", pkg, version)
		}
	}
	return nil
}
