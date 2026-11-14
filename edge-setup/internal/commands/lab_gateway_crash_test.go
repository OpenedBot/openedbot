package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const (
	labTestRuntime = "750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a"
	labTestNonce   = "e91f2fdf-daab-49c7-9e61-f638fdaa3074"
	labTestOld     = "Mon 2026-11-09 02:00:00 UTC"
	labTestNew     = "Mon 2026-11-09 02:00:03 UTC"
	labTestKill    = "/usr/bin/systemctl kill --kill-whom=main --signal=SIGKILL hermes-gateway"
	labTestPID     = "/usr/bin/systemctl show hermes-gateway --property=MainPID --value"
	labTestStart   = "/usr/bin/systemctl show hermes-gateway --property=ActiveEnterTimestamp --value"
)

func labTestFixture(t *testing.T, variant ...string) (labCrashOptions, labCrashDependencies, *exectest.Fake) {
	t.Helper()
	options := labCrashOptions{Instance: layout.ConnectorInstance("lab"), RuntimeID: labTestRuntime, Nonce: labTestNonce}
	fake := exectest.NewFake()
	fake.On(labConnectorUnitsCommand, exec.Result{Stdout: `[{"unit":"hermes-connector@lab.service","load":"loaded","active":"active","sub":"running"},{"unit":"hermes-connector.service","load":"loaded","active":"inactive","sub":"dead"}]`})
	var pids []exec.Result
	pidValues := []string{"100", "100", "100", "100", "0", "200", "200", "200"}
	starts := []exec.Result{{Stdout: labTestOld}, {Stdout: labTestOld}, {Stdout: labTestNew}}
	if len(variant) > 0 {
		switch variant[0] {
		case "invalid-pid":
			pidValues = []string{"--all"}
		case "invalid-start":
			starts = []exec.Result{{Stdout: "n/a"}}
		case "no-stop":
			pidValues = []string{"100", "100", "100", "100", "200"}
		case "no-restart":
			pidValues = []string{"100"}
		case "same-start":
			starts = []exec.Result{{Stdout: labTestOld}}
		}
	}
	for _, pid := range pidValues {
		pids = append(pids, exec.Result{Stdout: pid})
	}
	fake.OnSequence(labTestPID, pids...)
	fake.OnSequence(labTestStart, starts...)
	fake.On(labTestKill, exec.Result{})
	deps := labCrashDependencies{
		Runner: fake, StateDir: filepath.Join(t.TempDir(), "receipts"), Owner: fsx.Current(), Poll: time.Millisecond,
		ReadLink: func(layout.ConnectorInstance) (*LinkFile, error) {
			return &LinkFile{RuntimeID: labTestRuntime, Environment: "dev"}, nil
		},
		Environment: func(layout.ConnectorInstance, string) (string, error) { return "dev", nil },
		Healthy:     func(context.Context) error { return nil },
	}
	return options, deps, fake
}

func TestLabCrashCLIRequiresExplicitConsentAndCleanIdentifiers(t *testing.T) {
	env := cli.Env{Stdout: io.Discard, Stderr: io.Discard}
	valid := []string{"gateway-crash", "--yes", "--allow-lab-fault", "--json", "--runtime-id", labTestRuntime, "--nonce", labTestNonce, "--name", "lab"}
	if _, err := parseLabCrash(env, valid); err != nil {
		t.Fatal(err)
	}
	for _, arg := range []string{"--yes", "--allow-lab-fault", "--json"} {
		t.Run(arg, func(t *testing.T) {
			var args []string
			for _, value := range valid {
				if value != arg {
					args = append(args, value)
				}
			}
			if _, err := parseLabCrash(env, args); err == nil {
				t.Fatal("consent flag was optional")
			}
		})
	}
	for _, extra := range [][]string{{"--unit", "sshd"}, {"--signal", "SIGTERM"}, {"--command", "true"}, {"positional"}, {"--runtime-id", "../runtime"}, {"--nonce", "not-a-uuid"}, {"--name", "../prod"}} {
		if _, err := parseLabCrash(env, append(append([]string{}, valid...), extra...)); err == nil {
			t.Fatalf("hostile flags accepted: %v", extra)
		}
	}
	if !cli.NeedsRoot("lab") {
		t.Fatal("the lab command must be elevated")
	}
}

func TestLabCrashSignalsOnlyTheFixedGatewayAndWritesProcessEvidence(t *testing.T) {
	options, deps, fake := labTestFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	proof, err := executeLabGatewayCrash(ctx, options, deps)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Before.PID != 100 || proof.After.PID != 200 || proof.Before.StartedAt != "2026-11-09T02:00:00Z" || proof.After.StartedAt != "2026-11-09T02:00:03Z" || !proof.StoppedObserved || !proof.Healthy || proof.RuntimeID != options.RuntimeID || proof.Nonce != options.Nonce || proof.Signal != "SIGKILL" {
		t.Fatalf("incomplete crash evidence: %+v", proof)
	}
	mutations := 0
	for _, command := range fake.Commands() {
		if strings.Contains(command, " kill ") {
			mutations++
			if command != labTestKill {
				t.Fatalf("unexpected mutation: %s", command)
			}
		}
	}
	if mutations != 1 {
		t.Fatalf("got %d signals", mutations)
	}
	data, err := os.ReadFile(filepath.Join(deps.StateDir, options.Nonce+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var receipt labCrashEvidence
	if json.Unmarshal(data, &receipt) != nil || receipt != *proof {
		t.Fatalf("receipt mismatch: %s", data)
	}
}

func TestLabCrashRefusesWrongRuntimeProductionOrForeignConnectorsBeforeSignal(t *testing.T) {
	for _, name := range []string{"runtime", "production", "enrollment-production", "context-failed", "active-other", "transitioning-other", "invalid-list", "invalid-pid", "invalid-start", "preflight-health", "malformed-runtime", "malformed-nonce"} {
		t.Run(name, func(t *testing.T) {
			options, deps, fake := labTestFixture(t, name)
			switch name {
			case "runtime":
				options.RuntimeID = "850b6e7c-6fb3-4fbd-8d79-b4bb8451b69a"
			case "production":
				deps.Environment = func(layout.ConnectorInstance, string) (string, error) { return "production", nil }
			case "enrollment-production":
				deps.ReadLink = func(layout.ConnectorInstance) (*LinkFile, error) {
					return &LinkFile{RuntimeID: labTestRuntime, Environment: "prod"}, nil
				}
			case "context-failed":
				deps.Environment = func(layout.ConnectorInstance, string) (string, error) { return "", errors.New("unavailable") }
			case "active-other", "transitioning-other":
				state := "active"
				if name == "transitioning-other" {
					state = "activating"
				}
				fake.On(labConnectorUnitsCommand, exec.Result{Stdout: `[{"unit":"hermes-connector@lab.service","load":"loaded","active":"active","sub":"running"},{"unit":"hermes-connector.service","load":"loaded","active":"` + state + `","sub":"running"}]`})
			case "invalid-list":
				fake.On(labConnectorUnitsCommand, exec.Result{Stdout: `{}`})
			case "preflight-health":
				deps.Healthy = func(context.Context) error { return errors.New("unavailable") }
			case "malformed-runtime":
				options.RuntimeID = "not-a-uuid"
			case "malformed-nonce":
				options.Nonce = "../nonce"
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if proof, err := executeLabGatewayCrash(ctx, options, deps); err == nil || proof != nil {
				t.Fatal("unsafe preflight accepted")
			}
			if fake.Ran(labTestKill) {
				t.Fatal("a refused target was signalled")
			}
		})
	}
}

func TestLabCrashNeverClaimsAnUnobservedStopOrUnhealthyRelaunch(t *testing.T) {
	for _, name := range []string{"no-stop", "no-restart", "same-start", "post-health", "signal-error"} {
		t.Run(name, func(t *testing.T) {
			options, deps, fake := labTestFixture(t, name)
			switch name {
			case "post-health":
				reads := 0
				deps.Healthy = func(context.Context) error {
					reads++
					if reads > 1 {
						return errors.New("unavailable")
					}
					return nil
				}
			case "signal-error":
				fake.On(labTestKill, exec.Result{ExitCode: 1})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
			defer cancel()
			if proof, err := executeLabGatewayCrash(ctx, options, deps); err == nil || proof != nil {
				t.Fatal("incomplete process evidence accepted")
			}
			data, err := os.ReadFile(filepath.Join(deps.StateDir, options.Nonce+".json"))
			if err != nil || !bytes.Contains(data, []byte(`"state":"reserved"`)) {
				t.Fatalf("an incomplete fault lost its reservation: %s (%v)", data, err)
			}
		})
	}
}

func TestLabCrashNonceAndLockPreventDuplicateFaults(t *testing.T) {
	options, deps, _ := labTestFixture(t)
	first, err := reserveLabCrash(deps.StateDir, deps.Owner, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reserveLabCrash(deps.StateDir, deps.Owner, options); err == nil {
		t.Fatal("concurrent fault took the same host lock")
	}
	first.Close()
	if _, err := reserveLabCrash(deps.StateDir, deps.Owner, options); err == nil {
		t.Fatal("interrupted fault nonce was replayable")
	}
}
