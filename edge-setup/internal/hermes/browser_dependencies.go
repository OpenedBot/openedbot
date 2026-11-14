package hermes

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hostfacts"
)

// EnsureLabChromiumDependencies is called only by guarded browser-fixture
// setup. It touches no repository configuration and invokes no global OS upgrade.
// The CLI still proves actual browser startup as the unprivileged Hermes UID.
func EnsureLabChromiumDependencies(ctx context.Context, runner exec.Runner) error {
	if runner == nil {
		return fmt.Errorf("chromium dependency provisioning requires a command runner")
	}
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return fmt.Errorf("chromium dependency provisioning requires Linux root")
	}
	// Only local distribution facts are needed: no optional host commands.
	facts, err := hostfacts.Default(nil).Collect(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	return ensureChromiumDependencies(ctx, apt.New(runner), facts)
}

// Fixed library set from Playwright v1.58.2 nativeDeps.ts chromium mappings
// (browsers.json pins revision 1208 / 145.0.7632.6 exactly), plus its basic fonts:
// https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/registry/nativeDeps.ts
// Debian t64 names verified against https://packages.debian.org/trixie/ and
// Ubuntu Noble against https://packages.ubuntu.com/noble/. No runtime lookup
// or caller-supplied package selection is permitted.
func chromiumDependencyPackages(facts hostfacts.Facts) ([]string, error) {
	t64 := false
	switch {
	case facts.OSID == "debian" && facts.OSVersionID == 12 && facts.OSCodename == "bookworm":
	case facts.OSID == "debian" && facts.OSVersionID == 13 && facts.OSCodename == "trixie":
		t64 = true
	case facts.OSID == "ubuntu" && facts.OSVersionID == 24 && facts.OSCodename == "noble":
		t64 = true
	default:
		return nil, fmt.Errorf("chromium dependency provisioning supports only Debian 12 bookworm, Debian 13 trixie, or Ubuntu 24.04 noble; found %s %d %s", facts.OSID, facts.OSVersionID, facts.OSCodename)
	}
	if facts.Arch != "amd64" && facts.Arch != "arm64" {
		return nil, fmt.Errorf("chromium dependencies unsupported on architecture %s", facts.Arch)
	}
	packages := []string{"fonts-liberation", "fonts-noto-color-emoji", "libfontconfig1", "libfreetype6", "libcairo2", "libdbus-1-3", "libdrm2", "libgbm1", "libnspr4", "libnss3", "libpango-1.0-0", "libx11-6", "libxcb1", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0", "libxrandr2"}
	suffix := ""
	if t64 {
		suffix = "t64"
	}
	for _, pkg := range []string{"libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcups2", "libglib2.0-0"} {
		packages = append(packages, pkg+suffix)
	}
	return packages, nil
}
func ensureChromiumDependencies(ctx context.Context, client apt.Client, facts hostfacts.Facts) error {
	packages, err := chromiumDependencyPackages(facts)
	if err != nil {
		return err
	}
	return client.InstallMissing(ctx, packages...)
}
