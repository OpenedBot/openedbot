package commands

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func labMCPTestFixture(t *testing.T) (labMCPOptions, labMCPDependencies, *[]string) {
	t.Helper()
	target, guarded, _ := labTestFixture(t)
	options := labMCPOptions{Target: target, Action: "setup", Profile: "e2e-fixture-owned"}
	actions := []string{}
	deps := labMCPDependencies{Target: guarded, StateDir: filepath.Join(t.TempDir(), "receipts"), ScriptPath: "/fixed/lab-mcp.py", Install: func() error { return nil }}
	deps.Run = func(_ context.Context, request map[string]any) (labMCPResult, error) {
		action := request["action"].(string)
		actions = append(actions, action)
		result := labMCPResult{Installed: true, Online: action != "offline", Calls: []labMCPCall{}, Processes: []labMCPProcess{}}
		if action == "remove" || action == "cleanup" {
			result.Installed = false
			result.Online = false
			result.Removed = action == "cleanup"
		}
		return result, nil
	}
	return options, deps, &actions
}

func TestLabMCPCLIRefusesArbitraryCommandsProfilesOrMissingConsent(t *testing.T) {
	env := cli.Env{Stdout: io.Discard, Stderr: io.Discard}
	valid := []string{"setup", "--yes", "--allow-lab-fault", "--json", "--runtime-id", labTestRuntime, "--nonce", labTestNonce, "--profile", "e2e-owned", "--name", "lab"}
	if _, err := parseLabMCP(env, valid); err != nil {
		t.Fatal(err)
	}
	for _, extra := range [][]string{{"--command", "id"}, {"--path", "/tmp/other"}, {"--profile", "operator"}, {"--profile", "e2e-../operator"}, {"--yes=false"}, {"--nonce", "../x"}} {
		if _, err := parseLabMCP(env, append(append([]string{}, valid...), extra...)); err == nil {
			t.Fatalf("unsafe option accepted: %v", extra)
		}
	}
	invalid := append([]string{}, valid...)
	invalid[0] = "setup|online"
	if _, err := parseLabMCP(env, invalid); err == nil {
		t.Fatal("combined actions accepted")
	}
}

func TestLabMCPSetupReplaysExactOwnershipWithoutRecreatingSecret(t *testing.T) {
	options, deps, actions := labMCPTestFixture(t)
	first, err := executeLabMCP(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	second, err := executeLabMCP(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Installed || first.Replayed || !second.Replayed || first.Secret == "" || second.Secret != first.Secret || first.ToolName != "mcp__"+first.ServerName+"__read_probe" {
		t.Fatalf("bad replay: %+v %+v", first, second)
	}
	options.Action = "receipts"
	read, err := executeLabMCP(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	if read.Secret != "" || len(*actions) != 3 {
		t.Fatal("receipts leaked secret or missed worker read")
	}
	options.Profile = "e2e-foreign"
	if _, err := executeLabMCP(context.Background(), options, deps); err == nil {
		t.Fatal("receipt reused for another profile")
	}
}

func TestLabMCPRefusesProductionOrUnownedCleanupBeforeWorker(t *testing.T) {
	options, deps, actions := labMCPTestFixture(t)
	deps.Target.Environment = func(layout.ConnectorInstance, string) (string, error) { return "prod", nil }
	if _, err := executeLabMCP(context.Background(), options, deps); err == nil || len(*actions) != 0 {
		t.Fatal("production reached fixture worker")
	}
	deps.Target.Environment = func(layout.ConnectorInstance, string) (string, error) { return "dev", nil }
	options.Action = "remove"
	if _, err := executeLabMCP(context.Background(), options, deps); err == nil || len(*actions) != 0 {
		t.Fatal("unowned cleanup reached worker")
	}
}

func TestLabMCPRemovalPersistsCallsBeforeCleanupAndResumesAfterInterruption(t *testing.T) {
	options, deps, _ := labMCPTestFixture(t)
	if _, err := executeLabMCP(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	cleanupFails := true
	deps.Run = func(_ context.Context, request map[string]any) (labMCPResult, error) {
		action := request["action"].(string)
		result := labMCPResult{Calls: []labMCPCall{{Challenge: "exact-challenge", Succeeded: true}}, Processes: []labMCPProcess{{PID: 55, StartTicks: "123", Running: false}}, Starts: 1}
		if action == "cleanup" {
			data, err := os.ReadFile(filepath.Join(deps.StateDir, options.Target.Nonce+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var receipt labMCPReceipt
			if json.Unmarshal(data, &receipt) != nil || receipt.State != "removing" || len(receipt.Calls) != 1 || receipt.Starts != 1 {
				t.Fatal("cleanup preceded durable final receipts")
			}
			if cleanupFails {
				return result, errors.New("interrupted cleanup")
			}
			result.Removed = true
		}
		return result, nil
	}
	options.Action = "remove"
	if _, err := executeLabMCP(context.Background(), options, deps); err == nil {
		t.Fatal("interrupted cleanup accepted")
	}
	cleanupFails = false
	removed, err := executeLabMCP(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	if !removed.Removed || removed.Installed || removed.Online || len(removed.Calls) != 1 || removed.Starts != 1 {
		t.Fatalf("incomplete cleanup evidence: %+v", removed)
	}
	deps.Run = func(context.Context, map[string]any) (labMCPResult, error) {
		t.Fatal("removed fixture re-entered worker")
		return labMCPResult{}, nil
	}
	if _, err := executeLabMCP(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	options.Action = "setup"
	if _, err := executeLabMCP(context.Background(), options, deps); err == nil {
		t.Fatal("removed fixture recreated")
	}
}

func TestLabMCPRejectsMalformedOrUnboundedWorkerEvidence(t *testing.T) {
	for _, output := range []string{`{}`, `{"installed":false,"online":false,"calls":[],"removed":false,"processes":[{"pid":1,"startTicks":"123","running":false},{"pid":1,"startTicks":"123","running":true}],"starts":2}`, `{"installed":false,"online":false,"calls":[],"removed":false,"processes":[],"starts":1}`, `{"installed":false,"online":false,"calls":[{"challenge":"../x","succeeded":true}],"removed":false,"processes":[],"starts":0}`} {
		if _, err := parseLabMCPResult(output); err == nil {
			t.Fatal("invalid fixture evidence accepted")
		}
	}
}
