package commands

import (
	"os"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// installedHermesVersion is the Hermes version hello announces: the one the
// host's install stamp records, never pins.HermesVersion. An edge-setup
// upgraded without `up` must not claim a Hermes it has not installed. On
// macOS the checkout is keyed by the pinned commit, so a release this binary
// has not installed yet reads as unknown ("") rather than as the pin.
func installedHermesVersion() string {
	if runtime.GOOS != "darwin" {
		return hermes.InstalledVersion(layout.InstallDir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return ""
	}
	return hermes.InstalledVersion(p.InstallDir)
}
