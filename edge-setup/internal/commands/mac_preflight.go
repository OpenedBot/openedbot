package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type macPreflight struct {
	OperatingSystem string                 `json:"operating_system"`
	Architecture    string                 `json:"architecture"`
	UserID          int                    `json:"user_id"`
	Supported       bool                   `json:"supported"`
	Ready           bool                   `json:"ready"`
	Paths           layout.MacRuntimePaths `json:"paths"`
	Checks          map[string]bool        `json:"checks"`
	Reasons         []string               `json:"reasons"`
}

func collectMacPreflight(ctx context.Context, home, arch string, r exec.Runner) (macPreflight, error) {
	return collectMacPreflightForUID(ctx, home, arch, r, os.Geteuid())
}

func collectMacPreflightForUID(ctx context.Context, home, arch string, r exec.Runner, uid int) (macPreflight, error) {
	p, err := layout.MacRuntime(home)
	if err != nil {
		return macPreflight{}, err
	}
	_, supported := pins.MacArches[arch]
	result := macPreflight{OperatingSystem: "darwin", Architecture: arch, UserID: uid, Supported: supported, Paths: p,
		Checks: map[string]bool{"architecture": supported, "user": uid > 0, "gui_domain": false, "git": false}, Reasons: []string{}}
	if !supported {
		result.Reasons = append(result.Reasons, "this macOS architecture has no verified artifacts")
	}
	if uid <= 0 {
		result.Reasons = append(result.Reasons, "run as the logged-in macOS user, without sudo")
	}
	if r == nil {
		result.Reasons = append(result.Reasons, "host prerequisite inspection is unavailable")
		return result, nil
	}
	if uid > 0 {
		res, err := r.Run(ctx, exec.Cmd{Path: "/bin/launchctl", Args: []string{"print", "gui/" + strconv.Itoa(uid)}, Timeout: 10 * time.Second})
		result.Checks["gui_domain"] = err == nil && res.ExitCode == 0 && strings.TrimSpace(res.Stderr) == ""
		if !result.Checks["gui_domain"] {
			result.Reasons = append(result.Reasons, "the user's GUI launchd domain could not be verified")
		}
	}
	if _, err := hermes.MacGit(ctx, r); err != nil {
		result.Reasons = append(result.Reasons, err.Error())
	} else {
		result.Checks["git"] = true
	}
	result.Ready = len(result.Reasons) == 0
	return result, nil
}

func runMacDetect(env cli.Env, asJSON bool) int {
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home could not be resolved")
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	result, err := collectMacPreflight(ctx, home, runtime.GOARCH, runner)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS preflight paths could not be resolved")
	}
	if asJSON {
		data, _ := json.MarshalIndent(result, "", "  ")
		printf(env.Stdout, "%s", data)
	} else {
		printf(env.Stdout, "host        macOS %s user=%d service_manager=launchd", result.Architecture, result.UserID)
		printf(env.Stdout, "runtime     %s", result.Paths.RuntimeRoot)
		for _, reason := range result.Reasons {
			printf(env.Stdout, "preflight   %s %s", env.Color.Red("✗"), reason)
		}
		if result.Ready {
			printf(env.Stdout, "preflight   %s ready for the pinned user runtime", env.Color.Green("✓"))
		}
	}
	if !result.Ready {
		return cli.ExitFailure
	}
	return cli.ExitOK
}

func runMacPlan(env cli.Env, options *upOptions) int {
	if err := validateMacUpOptions(options); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	if code := prepareConnectorHostAllowingLegacy(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home could not be resolved")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS runtime paths could not be resolved")
	}
	for _, line := range macPlanLines(p) {
		printf(env.Stdout, "%s", line)
	}
	if err := refuseUnmovedMacLegacy(home); err != nil {
		legacy, _ := layout.MacRuntimeIn(layout.MacLegacy, home)
		printf(env.Stdout, "move the installation from before the rename %s to %s, then rebuild its Python environments", legacy.AppRoot, p.AppRoot)
	}
	return cli.ExitOK
}

func macPlanLines(p layout.MacRuntimePaths) []string {
	return []string{
		"+-------------------------------------+",
		"| Inspect user GUI and developer Git  |",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Prepare pinned private runtime      |",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Start gateway and operator agents   |",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Prove health, policy, capabilities  |",
		"+-------------------------------------+",
		"reachability connector (outbound only)",
		"user runtime " + p.RuntimeRoot,
		"versioned checkout " + p.InstallDir,
		fmt.Sprintf("pins Hermes %s @ %s, uv %s, Python %s, Node %s", pins.HermesVersion, pins.HermesInstallerCommit[:12], pins.UVVersion, pins.PythonVersion, pins.NodeVersion),
		"services " + layout.MacCurrent.LabelPrefix + "gateway, " + layout.MacCurrent.LabelPrefix + "operator",
		"connector " + layout.MacCurrent.LabelPrefix + "connector.<instance> starts after link",
		"preserve existing provider credentials, device keys and personal ~/.hermes",
		"Linux host-policy and Docker provisioning flags are unavailable on macOS",
		"writes " + p.ToolConfig,
	}
}
