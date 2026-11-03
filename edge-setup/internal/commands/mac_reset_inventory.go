package commands

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const macResetLabelPrefix = "com.openhermesbot.edge-setup."

// launchctl list observes the caller's bootstrap. Verify that it is this
// user's Aqua manager before using it to find jobs with missing metadata.
func macResetRegisteredInstances(ctx context.Context, r exec.Runner, uid int) ([]layout.ConnectorInstance, error) {
	if r == nil || uid <= 0 {
		return nil, errors.New("macOS reset requires the logged-in user's desktop Terminal")
	}
	for _, check := range []struct{ verb, want string }{{"manageruid", strconv.Itoa(uid)}, {"managername", "Aqua"}} {
		result, err := r.Run(ctx, exec.Cmd{Path: "/bin/launchctl", Args: []string{check.verb}, Timeout: 10 * time.Second})
		if err != nil || result.ExitCode != 0 || strings.TrimSpace(result.Stderr) != "" || strings.TrimSpace(result.Stdout) != check.want {
			return nil, errors.New("macOS reset could not verify this user's Aqua launchd manager")
		}
	}
	result, err := r.Run(ctx, exec.Cmd{Path: "/bin/launchctl", Args: []string{"list"}, Timeout: 10 * time.Second})
	if err != nil || result.ExitCode != 0 || strings.TrimSpace(result.Stderr) != "" {
		return nil, errors.New("macOS reset LaunchAgent inventory is unknown")
	}
	return parseMacResetList(result.Stdout)
}

func parseMacResetList(body string) ([]layout.ConnectorInstance, error) {
	if len(body) > 1<<20 || strings.ContainsAny(body, "\x00\r") {
		return nil, errors.New("macOS reset LaunchAgent inventory is invalid")
	}
	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) == 0 || strings.Join(strings.Fields(lines[0]), " ") != "PID Status Label" {
		return nil, errors.New("macOS reset LaunchAgent inventory has an unknown format")
	}
	instances := []layout.ConnectorInstance{}
	seen := map[string]bool{}
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			return nil, errors.New("macOS reset LaunchAgent inventory is truncated")
		}
		if fields[0] != "-" {
			pid, err := strconv.ParseInt(fields[0], 10, 32)
			if err != nil || pid <= 0 {
				return nil, errors.New("macOS reset LaunchAgent inventory has an invalid PID")
			}
		}
		if _, err := strconv.ParseInt(fields[1], 10, 32); err != nil {
			return nil, errors.New("macOS reset LaunchAgent inventory has an invalid status")
		}
		label := strings.Join(fields[2:], " ")
		if !strings.HasPrefix(label, macResetLabelPrefix) {
			continue
		}
		if seen[label] || len(seen) >= 256 {
			return nil, errors.New("macOS reset LaunchAgent inventory is ambiguous or too large")
		}
		seen[label] = true
		if label == macResetLabelPrefix+"gateway" || label == macResetLabelPrefix+"operator" {
			continue
		}
		name, ok := strings.CutPrefix(label, macResetLabelPrefix+"connector.")
		if !ok {
			return nil, errors.New("macOS reset found an unknown service in its namespace")
		}
		if name == "default" {
			name = ""
		}
		instance, err := layout.ParseConnectorInstance(name)
		if err != nil || label != macResetLabelPrefix+"connector."+instance.Label() {
			return nil, errors.New("macOS reset found an invalid connector label")
		}
		instances = append(instances, instance)
	}
	sort.Slice(instances, func(i, j int) bool { return instances[i] < instances[j] })
	return instances, nil
}
