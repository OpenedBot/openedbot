package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

const labConnectorUnitsCommand = "/usr/bin/systemctl list-units --type=service --all --output=json --no-pager hermes-connector*.service"

type labCrashProcess struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
}

type labCrashEvidence struct {
	SchemaVersion   int             `json:"schemaVersion"`
	Kind            string          `json:"kind"`
	Nonce           string          `json:"nonce"`
	RuntimeID       string          `json:"runtimeId"`
	Signal          string          `json:"signal"`
	StoppedObserved bool            `json:"stoppedObserved"`
	Healthy         bool            `json:"healthy"`
	Before          labCrashProcess `json:"before"`
	After           labCrashProcess `json:"after"`
}

func requireOnlyLabConnector(ctx context.Context, runner exec.Runner, instance layout.ConnectorInstance) error {
	// Listing live units also catches orphaned or transient instances whose
	// configuration directory no longer exists. Directory discovery alone
	// would miss another organization sharing this one gateway.
	output, err := exec.Output(ctx, runner, "/usr/bin/systemctl", "list-units", "--type=service", "--all", "--output=json", "--no-pager", "hermes-connector*.service")
	if err != nil {
		return errors.New("active connector inventory could not be read; no fault is allowed")
	}
	var units []struct {
		Unit   string `json:"unit"`
		Load   string `json:"load"`
		Active string `json:"active"`
		Sub    string `json:"sub"`
	}
	if len(output) > 65536 || json.Unmarshal([]byte(output), &units) != nil || units == nil {
		return errors.New("active connector inventory is invalid")
	}
	selected := 0
	for _, unit := range units {
		if unit.Unit == instance.Unit()+".service" {
			if unit.Load != "loaded" || unit.Active != "active" || unit.Sub != "running" {
				return errors.New("the selected connector must be active and running")
			}
			selected++
			continue
		}
		if !strings.HasPrefix(unit.Unit, "hermes-connector") || !strings.HasSuffix(unit.Unit, ".service") || (unit.Active != "inactive" && unit.Active != "failed") {
			return errors.New("another connector is active or has uncertain state; the shared gateway must not be crashed")
		}
	}
	if selected != 1 {
		return errors.New("exactly one selected active connector is required")
	}
	return nil
}

func readLabGatewayPID(ctx context.Context, sd systemd.Client) (int, error) {
	raw, err := sd.Show(ctx, layout.GatewayUnit, "MainPID")
	if err != nil {
		return 0, err
	}
	value := strings.TrimSpace(raw)
	pid, err := strconv.Atoi(value)
	if err != nil || pid < 0 || strconv.Itoa(pid) != value {
		return 0, errors.New("the gateway main PID is invalid")
	}
	return pid, nil
}

func readLabGatewayProcess(ctx context.Context, sd systemd.Client) (labCrashProcess, error) {
	var process labCrashProcess
	pid, err := readLabGatewayPID(ctx, sd)
	if err != nil || pid == 0 {
		return process, errors.New("the gateway must have a readable live main process")
	}
	raw, err := sd.Show(ctx, layout.GatewayUnit, "ActiveEnterTimestamp")
	if err != nil {
		return process, errors.New("the gateway startup time could not be read")
	}
	// Same systemd formats as operator.gatewayActiveSince, the independent
	// API observation the E2E runner compares with this process receipt.
	var started time.Time
	for _, format := range []string{"Mon 2006-01-02 15:04:05 MST", "2006-01-02 15:04:05 MST", time.RFC3339Nano} {
		if parsed, err := time.Parse(format, strings.TrimSpace(raw)); err == nil {
			started = parsed
			break
		}
	}
	if started.IsZero() {
		return process, errors.New("the gateway startup time is invalid")
	}
	confirmed, err := readLabGatewayPID(ctx, sd)
	if err != nil || confirmed != pid {
		return process, errors.New("the gateway process changed while its identity was being read")
	}
	return labCrashProcess{PID: pid, StartedAt: started.UTC().Format(time.RFC3339Nano)}, nil
}

func waitLabGatewayRelaunch(ctx context.Context, sd systemd.Client, before labCrashProcess, poll time.Duration) (labCrashProcess, error) {
	var stopped bool
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		pid, err := readLabGatewayPID(ctx, sd)
		if err == nil {
			if pid == 0 {
				stopped = true
			} else if pid != before.PID {
				if !stopped {
					return labCrashProcess{}, errors.New("the gateway changed without an independently observed stopped process")
				}
				after, err := readLabGatewayProcess(ctx, sd)
				if err == nil {
					oldStart, _ := time.Parse(time.RFC3339Nano, before.StartedAt)
					newStart, _ := time.Parse(time.RFC3339Nano, after.StartedAt)
					if !newStart.After(oldStart) || after.PID == before.PID {
						return labCrashProcess{}, errors.New("the new gateway process has no later startup identity")
					}
					return after, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return labCrashProcess{}, fmt.Errorf("automatic gateway relaunch was not proven: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}
