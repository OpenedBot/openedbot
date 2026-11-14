package hermes

import (
	"encoding/json"
	"path/filepath"
	"regexp"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// installedVersionPattern bounds what hello may carry: a dotted version with an
// optional pre-release or build suffix, never free text (the control plane
// stores at most 64 characters, runtimes.link_hermes_version).
var installedVersionPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]{1,32})?$`)

// InstalledVersion is the Hermes version recorded by the install stamp that
// `up` writes beside the checkout (writeInstallStamp). It returns "" when the
// stamp is missing, unreadable, malformed or carries no well-formed version:
// the connector then announces no version rather than the version this binary
// pins, which would hide a pending Hermes update after an edge-setup upgrade.
func InstalledVersion(installDir string) string {
	data, err := fsx.ReadFile(filepath.Join(installDir, "install-stamp.json"))
	if err != nil || len(data) > 64<<10 {
		return ""
	}
	var stamp struct {
		DisplayVersion string `json:"displayVersion"`
		BaseVersion    string `json:"baseVersion"`
	}
	if json.Unmarshal(data, &stamp) != nil {
		return ""
	}
	for _, v := range []string{stamp.DisplayVersion, stamp.BaseVersion} {
		if installedVersionPattern.MatchString(v) {
			return v
		}
	}
	return ""
}
