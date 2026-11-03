package hermes

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

const providerSDKProbeScript = `import importlib.util
import json
import sys

result = {}
for module in sys.argv[1:]:
    try:
        result[module] = importlib.util.find_spec(module) is not None
    except Exception:
        result[module] = False
print(json.dumps(result, separators=(",", ":")))
`

// ProviderSDKStatus reports whether one provider's pinned SDK can be found by
// the Python interpreter used by the Hermes gateway.
type ProviderSDKStatus struct {
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	Extra     string `json:"extra"`
	Installed bool   `json:"installed"`
	// Installable is true when `edge-setup up` installs this SDK (its extra
	// is in pins.HermesExtras): only then may the console offer that command.
	Installable bool `json:"installable"`
}

func installedByUp(extra string) bool {
	for _, pinned := range pins.HermesExtras {
		if pinned == extra {
			return true
		}
	}
	return false
}

// ProbeProviderSDKs checks all pinned provider modules in one isolated Python
// process. Module names are argv values, never code interpolated into the
// script.
func ProbeProviderSDKs(ctx context.Context, r exec.Runner, python string) ([]ProviderSDKStatus, error) {
	args := []string{"-I", "-c", providerSDKProbeScript}
	for _, sdk := range pins.HermesProviderSDKs {
		args = append(args, sdk.Module)
	}
	result, err := r.Run(ctx, exec.Cmd{Path: python, Args: args, Timeout: 20 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("run provider SDK probe: %w", err)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("provider SDK probe exited with status %d", result.ExitCode)
	}
	var found map[string]*bool
	if err := json.Unmarshal([]byte(result.Stdout), &found); err != nil {
		return nil, fmt.Errorf("parse provider SDK probe output: %w", err)
	}
	statuses := make([]ProviderSDKStatus, 0, len(pins.HermesProviderSDKs))
	for _, sdk := range pins.HermesProviderSDKs {
		installed, ok := found[sdk.Module]
		if !ok || installed == nil {
			return nil, fmt.Errorf("provider SDK probe omitted module %q", sdk.Module)
		}
		statuses = append(statuses, ProviderSDKStatus{
			Provider: sdk.Provider, Label: sdk.Label, Extra: sdk.Extra, Installed: *installed,
			Installable: installedByUp(sdk.Extra),
		})
	}
	return statuses, nil
}

// MissingProviderSDKs returns the uninstalled providers in the input order.
func MissingProviderSDKs(statuses []ProviderSDKStatus) []ProviderSDKStatus {
	missing := make([]ProviderSDKStatus, 0, len(statuses))
	for _, status := range statuses {
		if !status.Installed {
			missing = append(missing, status)
		}
	}
	return missing
}

// ProviderSDKNotice formats the operator-facing warning for missing provider
// SDKs. An empty result means every checked SDK is installed.
func ProviderSDKNotice(statuses []ProviderSDKStatus) string {
	missing := MissingProviderSDKs(statuses)
	if len(missing) == 0 {
		return ""
	}
	labels := make([]string, 0, len(missing))
	for _, status := range missing {
		labels = append(labels, fmt.Sprintf("%s [%s]", status.Label, status.Extra))
	}
	return "provider SDKs not installed (lazy installs are off; runs on these providers fail): " + strings.Join(labels, ", ")
}

func (i *Installer) reportProviderSDKs(ctx context.Context, report *Report) {
	statuses, err := ProbeProviderSDKs(ctx, i.Runner, layout.VenvBin+"/python")
	if err != nil {
		i.Log("provider SDK probe failed: %v", err)
		return
	}
	report.MissingProviderSDKs = MissingProviderSDKs(statuses)
	if notice := ProviderSDKNotice(report.MissingProviderSDKs); notice != "" {
		i.Log("%s", notice)
	}
}

func hermesSyncArgs(project string, check bool) []string {
	args := []string{"sync", "--project", project}
	for _, extra := range pins.HermesExtras {
		args = append(args, "--extra", extra)
	}
	args = append(args, "--locked")
	if check {
		args = append(args, "--check")
	}
	return args
}
