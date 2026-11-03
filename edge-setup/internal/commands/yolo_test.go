package commands

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// yoloHost is a linked default instance with no daemon running, and two
// Hermes profiles of which one applies a lease.
func yoloHost(t *testing.T) (stateDir, runtimeRoot string) {
	t.Helper()
	redirectConnectorRoot(t)
	prevState, prevRuntime, prevNow := connectorStateRoot, yoloRuntimeRoot, yoloNow
	connectorStateRoot, yoloRuntimeRoot = t.TempDir(), t.TempDir()
	yoloNow = func() time.Time { return time.Unix(1_800_000_000, 0) }
	t.Cleanup(func() { connectorStateRoot, yoloRuntimeRoot, yoloNow = prevState, prevRuntime, prevNow })
	link := LinkFile{Schema: 1, OHB: "https://openedbot.test", WSURL: "wss://openedbot.test/relay",
		RuntimeID: "6f1f0f4e-2c1b-4d7a-9a55-6f0b7e8f9a10", LinkToken: "test-link-token"}
	data, _ := json.Marshal(link)
	linkPath := linkPathOf(layout.DefaultConnectorInstance)
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linkPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, slug := range []string{"designer", "dev"} {
		dir := filepath.Join(yoloRuntimeRoot, "profiles", slug, "plugins", yoloApprovalPlugin)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	lease := filepath.Join(yoloRuntimeRoot, "profiles", "designer", "plugins", yoloApprovalPlugin, yoloProfileFile)
	if err := os.WriteFile(lease, []byte(`{"schema":1,"leases":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return connectorStateRoot, yoloRuntimeRoot
}

func yoloEnv() (cli.Env, *bytes.Buffer, *bytes.Buffer) {
	var out, errb bytes.Buffer
	return cli.Env{Version: "test", Stdout: &out, Stderr: &errb}, &out, &errb
}

func TestYoloVerbsRefuseWithoutYes(t *testing.T) {
	stateDir, runtimeRoot := yoloHost(t)
	for _, verb := range []string{"off", "on"} {
		env, _, errb := yoloEnv()
		if code := runYolo(env, []string{verb}); code != cli.ExitRefused || !strings.Contains(errb.String(), "(nothing was changed)") {
			t.Fatalf("yolo %s without --yes: code %d, %q", verb, code, errb.String())
		}
	}
	if _, err := os.Stat(filepath.Join(stateDir, connector.YoloKillFile)); !os.IsNotExist(err) {
		t.Fatalf("a refused verb wrote the kill file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeRoot, "profiles", "designer", "plugins", yoloApprovalPlugin, yoloProfileFile)); err != nil {
		t.Fatalf("a refused verb removed a profile's lease: %v", err)
	}
	for _, args := range [][]string{{}, {"maybe"}, {"off", "now"}, {"--yes"}} {
		env, _, _ := yoloEnv()
		if code := runYolo(env, args); code != cli.ExitUsage {
			t.Fatalf("yolo %v: code %d, want usage", args, code)
		}
	}
}

// `yolo off` works with no daemon at all: the kill file alone refuses every
// lease at the next start, and the plugin asks again from its next call.
func TestYoloOffWithTheDaemonStopped(t *testing.T) {
	stateDir, runtimeRoot := yoloHost(t)
	env, out, errb := yoloEnv()
	if code := yoloOff(env); code != cli.ExitOK {
		t.Fatalf("yolo off: code %d, %s", code, errb.String())
	}
	info, err := os.Stat(filepath.Join(stateDir, connector.YoloKillFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("kill file: %v %v", info, err)
	}
	kill, err := connector.ReadYoloKill(stateDir, yoloNow())
	if err != nil || !kill.Active() || kill.KilledAt != yoloNow().Unix() {
		t.Fatalf("kill = %+v, %v", kill, err)
	}
	if _, err := os.Stat(filepath.Join(runtimeRoot, "profiles", "designer", "plugins", yoloApprovalPlugin, yoloProfileFile)); !os.IsNotExist(err) {
		t.Fatalf("profile lease survived yolo off: %v", err)
	}
	if !strings.Contains(out.String(), "profile designer: lease file removed") {
		t.Fatalf("output: %s", out.String())
	}
	// A daemon started afterwards holds nothing issued before the kill.
	status := connector.ReadYoloStatus(stateDir, "6f1f0f4e-2c1b-4d7a-9a55-6f0b7e8f9a10", nil, yoloNow())
	if !status.Kill.Active() {
		t.Fatalf("status after off: %+v", status)
	}
	// Twice is harmless and never moves the kill back in time.
	yoloNow = func() time.Time { return time.Unix(1_700_000_000, 0) }
	if code := yoloOff(env); code != cli.ExitOK {
		t.Fatal("second yolo off failed")
	}
	if again, _ := connector.ReadYoloKill(stateDir, yoloNow()); again.KilledAt != 1_800_000_000 {
		t.Fatalf("kill moved back: %+v", again)
	}
}

func TestYoloOnLiftsOnlyTheLocalRefusal(t *testing.T) {
	stateDir, _ := yoloHost(t)
	env, out, _ := yoloEnv()
	if code := yoloOn(env); code != cli.ExitOK || !strings.Contains(out.String(), "nothing to lift") || !strings.Contains(out.String(), "cannot create a YOLO lease") {
		t.Fatalf("yolo on, not off: %s", out.String())
	}
	if code := yoloOff(env); code != cli.ExitOK {
		t.Fatal("yolo off failed")
	}
	yoloNow = func() time.Time { return time.Unix(1_800_000_600, 0) }
	out.Reset()
	if code := yoloOn(env); code != cli.ExitOK || !strings.Contains(out.String(), "cannot create a YOLO lease") {
		t.Fatalf("yolo on: %s", out.String())
	}
	kill, err := connector.ReadYoloKill(stateDir, yoloNow())
	if err != nil || kill.Active() || kill.KilledAt != 1_800_000_000 || kill.LiftedAt != 1_800_000_600 {
		t.Fatalf("kill after on = %+v, %v", kill, err)
	}
	// KilledAt is kept: leases issued before it stay refused once lifted
	// (connector tests: TestYoloKill*).
}

// An unreadable kill file is a kill now: lifting it keeps every lease issued
// until the lift refused instead of reviving the ones it had killed.
func TestYoloOnOverAnUnreadableKill(t *testing.T) {
	stateDir, _ := yoloHost(t)
	if err := os.WriteFile(filepath.Join(stateDir, connector.YoloKillFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	env, _, _ := yoloEnv()
	if code := yoloOn(env); code != cli.ExitOK {
		t.Fatal("yolo on failed")
	}
	kill, err := connector.ReadYoloKill(stateDir, yoloNow())
	if err != nil || kill.KilledAt != yoloNow().Unix() || kill.Active() {
		t.Fatalf("kill = %+v, %v", kill, err)
	}
}

func TestYoloStatusJSON(t *testing.T) {
	stateDir, _ := yoloHost(t)
	if err := os.WriteFile(filepath.Join(stateDir, "yolo-pending.jsonl"), []byte("{}\n{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env, out, errb := yoloEnv()
	if code := yoloStatus(env, true); code != cli.ExitOK {
		t.Fatalf("status: %d %s", code, errb.String())
	}
	var got struct {
		Instances []struct {
			Instance     string             `json:"instance"`
			RuntimeID    string             `json:"runtimeId"`
			Kill         connector.YoloKill `json:"kill"`
			PendingAudit int                `json:"pendingAudit"`
			Leases       []any              `json:"leases"`
		} `json:"instances"`
		Profiles []string `json:"profilesWithLease"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("status --json is not JSON: %v\n%s", err, out.String())
	}
	if len(got.Instances) != 1 || got.Instances[0].RuntimeID == "" || got.Instances[0].PendingAudit != 2 || got.Instances[0].Kill.Active() || got.Instances[0].Leases == nil {
		t.Fatalf("status = %+v", got)
	}
	if len(got.Profiles) != 1 || got.Profiles[0] != "designer" {
		t.Fatalf("profiles = %v", got.Profiles)
	}
	out.Reset()
	if code := yoloOff(env); code != cli.ExitOK {
		t.Fatal("yolo off failed")
	}
	out.Reset()
	if code := yoloStatus(env, false); code != cli.ExitOK || !strings.Contains(out.String(), "YOLO off since") || !strings.Contains(out.String(), "2 auto-approval(s)") {
		t.Fatalf("status text: %s", out.String())
	}
}

// The verb may come before its flags, as the docs write it. Only the
// parsing: running a verb needs root on Linux and, on macOS, the user's
// real runtime.
func TestYoloFlagsAfterTheVerb(t *testing.T) {
	for _, c := range []struct {
		args    []string
		verb    string
		jsonOut bool
	}{
		{[]string{"status", "--json"}, "status", true},
		{[]string{"--json", "status"}, "status", true},
		{[]string{"off", "--yes"}, "off", false},
		{[]string{"--yes", "on"}, "on", false},
	} {
		env, _, _ := yoloEnv()
		verb, jsonOut, code := parseYoloArgs(env, c.args)
		if code != cli.ExitOK || verb != c.verb || jsonOut != c.jsonOut {
			t.Fatalf("yolo %v: verb %q json %v code %d", c.args, verb, jsonOut, code)
		}
	}
}
