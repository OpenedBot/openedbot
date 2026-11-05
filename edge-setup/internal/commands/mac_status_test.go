package commands

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type macStatusStoreFake struct {
	keys  map[layout.ConnectorInstance][]byte
	errs  map[layout.ConnectorInstance]error
	reads []layout.ConnectorInstance
}

func (s *macStatusStoreFake) Create(context.Context, layout.ConnectorInstance, []byte) error {
	return nil
}

func (s *macStatusStoreFake) Read(_ context.Context, instance layout.ConnectorInstance) ([]byte, error) {
	s.reads = append(s.reads, instance)
	if err := s.errs[instance]; err != nil {
		return nil, err
	}
	if seed, ok := s.keys[instance]; ok {
		return append([]byte(nil), seed...), nil
	}
	return nil, devicekeys.ErrNotFound
}

func (s *macStatusStoreFake) Replace(context.Context, layout.ConnectorInstance, []byte) error {
	return nil
}

func prepareMacStatusGlobals(t *testing.T, p layout.MacRuntimePaths, fake *exectest.Fake) {
	t.Helper()
	oldRoot, oldStateRoot, oldOwner, oldRunner := connectorRoot, connectorStateRoot, connectorOwner, runner
	connectorRoot, connectorStateRoot, connectorOwner, runner = p.ConnectorRoot, p.StateRoot, fsx.Current(), fake
	t.Cleanup(func() {
		connectorRoot, connectorStateRoot, connectorOwner, runner = oldRoot, oldStateRoot, oldOwner, oldRunner
	})
}

func saveMacStatusState(t *testing.T, p layout.MacRuntimePaths) {
	t.Helper()
	st := state.New("fixture-version")
	st.Mode = state.ModeConnector
	if err := st.SaveTo(p.ToolConfig, fsx.Current()); err != nil {
		t.Fatal("could not write state owned by the current user")
	}
}

func saveMacStatusLink(t *testing.T, inst layout.ConnectorInstance, p layout.MacRuntimePaths, runtimeID string) {
	t.Helper()
	dir := inst.DirUnder(p.ConnectorRoot)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal("could not create temporary connector directory")
	}
	data, err := json.Marshal(LinkFile{
		Schema: 1, Openedbot: "https://openedbot.fixture.invalid", WSURL: "wss://link.fixture.invalid/ws",
		RuntimeID: runtimeID, LinkToken: "fixture-link-token-never-return-this",
	})
	if err != nil {
		t.Fatal("could not encode temporary link fixture")
	}
	if err := fsx.WriteAtomic(linkPathOf(inst), data, 0o600, fsx.Current()); err != nil {
		t.Fatal("could not write private temporary link fixture")
	}
}

func macStatusLaunchdFake() *exectest.Fake {
	return exectest.NewFake().OnPrefix("/bin/launchctl print ", exec.Result{Stdout: "state = running\npid = 731\n"})
}

func TestCollectMacStatusReportsUserOwnedStateAndMultipleKeychainInstances(t *testing.T) {
	home := t.TempDir()
	p, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS paths")
	}
	fake := macStatusLaunchdFake()
	prepareMacStatusGlobals(t, p, fake)
	saveMacStatusState(t, p)

	alpha := layout.ConnectorInstance("alpha")
	beta := layout.ConnectorInstance("beta")
	zeta := layout.ConnectorInstance("zeta")
	if err := os.MkdirAll(p.ConnectorRoot, 0o700); err != nil {
		t.Fatal("could not create private temporary connector root")
	}
	if err := os.Chmod(p.ConnectorRoot, 0o700); err != nil {
		t.Fatal("could not set private temporary connector root mode")
	}
	saveMacStatusLink(t, alpha, p, "runtime-alpha")
	saveMacStatusLink(t, beta, p, "runtime-beta")
	saveMacStatusLink(t, zeta, p, "runtime-zeta")
	refusalDir := zeta.DirUnder(p.StateRoot)
	if err := os.MkdirAll(refusalDir, 0o700); err != nil {
		t.Fatal("could not create temporary connector state directory")
	}
	if err := fsx.WriteAtomic(filepath.Join(refusalDir, linkRefusedMarker), []byte("reason=fixture-private-refusal-detail\n"), 0o600, fsx.Current()); err != nil {
		t.Fatal("could not write temporary refusal marker")
	}
	if err := os.MkdirAll(filepath.Join(p.ConnectorRoot, "empty-instance"), 0o700); err != nil {
		t.Fatal("could not create unlinked connector directory")
	}

	keyReason := errors.New("fixture keychain failure reason must not escape")
	store := &macStatusStoreFake{
		keys: map[layout.ConnectorInstance][]byte{
			alpha: []byte(strings.Repeat("s", ed25519.SeedSize)),
		},
		errs: map[layout.ConnectorInstance]error{beta: devicekeys.ErrNotFound, zeta: keyReason},
	}
	summary, err := collectMacStatus(context.Background(), home, p, store)
	if err != nil {
		t.Fatalf("user-owned macOS status collection failed: %v", err)
	}

	for key, want := range map[string]any{
		"configured":          true,
		"service_manager":     "launchd",
		"gateway_active":      true,
		"gateway_registered":  true,
		"operator_active":     true,
		"operator_registered": true,
		"connector_active":    true,
		"link_present":        false,
	} {
		if got := summary[key]; got != want {
			t.Errorf("status field %q = %v, want %v", key, got, want)
		}
	}
	hardening, ok := summary["hardening"].(map[string]any)
	if !ok || hardening["supported"] != false {
		t.Fatal("macOS status invented Linux host-hardening support")
	}
	autoUpgrade, ok := summary["auto_upgrade"].(map[string]any)
	if !ok || autoUpgrade["supported"] != false {
		t.Fatal("macOS status invented Linux auto-upgrade support")
	}
	if rollback, exists := summary["rollback_timer"]; !exists || rollback != nil {
		t.Fatal("macOS status should report no Linux rollback timer")
	}
	if st, ok := summary["state"].(*state.File); !ok || st.ToolVersion != "fixture-version" {
		t.Fatal("status did not load the private state file owned by the current user")
	}

	connectors, ok := summary["connectors"].([]macInstanceStatus)
	if !ok || len(connectors) != 4 {
		t.Fatalf("connector status did not keep the default-first linked-instance list: %T, %d entries", summary["connectors"], len(connectors))
	}
	for _, connector := range connectors {
		if connector.DeviceKey || connector.DeviceKeyStorage != "keychain" {
			t.Fatal("macOS connector status retained Linux sealed-key metadata or omitted Keychain storage")
		}
	}
	if connectors[0].Name != "default" || connectors[0].Link || connectors[0].Registered != true || connectors[0].DeviceKey || connectors[0].DeviceKeyAccessible != nil {
		t.Fatal("default status or no-link Keychain access is incorrect")
	}
	if connectors[1].Name != "alpha" || connectors[1].RuntimeID != "runtime-alpha" || !connectors[1].Link || connectors[1].DeviceKey || connectors[1].DeviceKeyStorage != "keychain" || connectors[1].DeviceKeyAccessible == nil || !*connectors[1].DeviceKeyAccessible {
		t.Fatal("successful Keychain read was not represented for the linked alpha instance")
	}
	if connectors[2].Name != "beta" || connectors[2].RuntimeID != "runtime-beta" || connectors[2].DeviceKeyAccessible == nil || *connectors[2].DeviceKeyAccessible || connectors[2].DeviceKeyError != "" {
		t.Fatal("missing Keychain item was not represented as inaccessible without a raw error")
	}
	if connectors[3].Name != "zeta" || connectors[3].RuntimeID != "runtime-zeta" || !connectors[3].Link || connectors[3].DeviceKey || connectors[3].DeviceKeyStorage != "keychain" || connectors[3].DeviceKeyAccessible == nil || *connectors[3].DeviceKeyAccessible || connectors[3].DeviceKeyError != "Keychain entry could not be read" || !connectors[3].Refused {
		t.Fatal("failed Keychain read or refusal state was not represented safely for zeta")
	}
	if len(store.reads) != 3 || store.reads[0] != alpha || store.reads[1] != beta || store.reads[2] != zeta {
		t.Fatal("Keychain was read for an unlinked instance or in an unstable order")
	}
	if len(fake.Calls) != 6 {
		t.Fatalf("launchctl status command count = %d, want gateway, operator, and four connectors", len(fake.Calls))
	}
	for _, call := range fake.Calls {
		if call.Path != "/bin/launchctl" || len(call.Args) < 2 || call.Args[0] != "print" {
			t.Fatal("status invoked something other than the fake launchctl print query")
		}
	}

	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal("status summary could not be encoded as JSON")
	}
	for _, secret := range []string{
		"fixture-link-token-never-return-this", strings.Repeat("s", ed25519.SeedSize),
		"fixture keychain failure reason must not escape", "fixture-private-refusal-detail",
	} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("status JSON exposed a link credential, device seed, keychain error, or refusal detail")
		}
	}
}

func TestCollectMacStatusReturnsErrorWhenLaunchdStateIsUnknown(t *testing.T) {
	home := t.TempDir()
	p, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS paths")
	}
	fake := exectest.NewFake()
	prepareMacStatusGlobals(t, p, fake)

	summary, err := collectMacStatus(context.Background(), home, p, &macStatusStoreFake{})
	if err == nil || summary != nil || !strings.Contains(err.Error(), "gateway LaunchAgent status is unknown") {
		t.Fatal("unknown launchctl state was converted into an ordinary false status")
	}
	if len(fake.Calls) != 1 || fake.Calls[0].Path != "/bin/launchctl" || strings.Join(fake.Calls[0].Args, " ") != "print gui/"+formatUID(os.Geteuid())+"/com.openhermesbot.edge-setup.gateway" {
		t.Fatal("unknown-state test did not exercise only the fake gateway status query")
	}
}

func TestCollectMacStatusDoesNotCreateAnAbsentConnectorRoot(t *testing.T) {
	home := t.TempDir()
	p, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS paths")
	}
	fake := macStatusLaunchdFake()
	prepareMacStatusGlobals(t, p, fake)
	store := &macStatusStoreFake{}

	summary, err := collectMacStatus(context.Background(), home, p, store)
	if err != nil {
		t.Fatalf("status with no connector root failed: %v", err)
	}
	connectors, ok := summary["connectors"].([]macInstanceStatus)
	if !ok || len(connectors) != 1 || connectors[0].Name != "default" || connectors[0].Link || connectors[0].DeviceKeyAccessible != nil {
		t.Fatal("absent connector root did not produce only a default, unlinked status")
	}
	if len(store.reads) != 0 {
		t.Fatal("absent connector root triggered a device-key lookup")
	}
	if _, err := os.Lstat(p.ConnectorRoot); !os.IsNotExist(err) {
		t.Fatal("status created or changed the absent connector root")
	}
}

func formatUID(uid int) string {
	return fmt.Sprintf("%d", uid)
}
