package apt

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

var missingPackageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]*$`)

// InstallMissing omits installed packages from the explicit request and
// refuses removals. APT may still upgrade transitive dependencies. It refreshes
// indexes only when necessary and proves the requested packages afterwards.
func (c Client) InstallMissing(ctx context.Context, packages ...string) error {
	var missing []string
	for _, pkg := range packages {
		if !missingPackageName.MatchString(pkg) {
			return fmt.Errorf("invalid dependency package name")
		}
		installed, err := c.fullyInstalled(ctx, pkg)
		if err != nil {
			return err
		}
		if !installed {
			missing = append(missing, pkg)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	if err := c.Update(ctx); err != nil {
		return fmt.Errorf("APT dependency index unavailable; check configured repositories and retry guarded setup: %w", err)
	}
	if err := c.withoutServiceStarts(func() error {
		args := append([]string{"install", "-y", "--no-install-recommends", "--no-upgrade", "--no-remove"}, missing...)
		_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: aptGet, Args: args, Env: c.env()})
		return err
	}); err != nil {
		return fmt.Errorf("APT could not install required libraries without removals or explicit-package upgrades; repair repositories/package conflicts then retry guarded setup: %w", err)
	}
	for _, pkg := range packages {
		installed, err := c.fullyInstalled(ctx, pkg)
		if err != nil {
			return err
		}
		if !installed {
			return fmt.Errorf("dependency %s is still not fully installed after APT; repair dpkg then retry guarded setup", pkg)
		}
	}
	return nil
}
func (c Client) fullyInstalled(ctx context.Context, pkg string) (bool, error) {
	result, err := c.Runner.Run(ctx, exec.Cmd{Path: dpkgQuery, Args: []string{"-W", "-f=${Status}\n", pkg}, Env: c.env(), Timeout: 15 * time.Second})
	if err != nil {
		return false, fmt.Errorf("cannot inspect Chromium dependency %s with dpkg-query: %w", pkg, err)
	}
	if result.ExitCode == 1 {
		return false, nil
	}
	if result.ExitCode != 0 {
		return false, fmt.Errorf("dpkg-query unavailable for dependency %s (exit %d)", pkg, result.ExitCode)
	}
	fields := strings.Fields(strings.TrimSpace(result.Stdout))
	if len(fields) != 3 || !dpkgDesiredState(fields[0]) || (fields[1] != "ok" && fields[1] != "reinstreq") || !dpkgPackageState(fields[2]) {
		return false, fmt.Errorf("unreadable dpkg status for dependency %s", pkg)
	}
	return (fields[0] == "install" || fields[0] == "hold") && fields[1] == "ok" && fields[2] == "installed", nil
}
func dpkgDesiredState(state string) bool {
	switch state {
	case "unknown", "install", "hold", "deinstall", "purge":
		return true
	}
	return false
}
func dpkgPackageState(state string) bool {
	switch state {
	case "not-installed", "config-files", "half-installed", "unpacked", "half-configured", "triggers-awaited", "triggers-pending", "installed":
		return true
	}
	return false
}
