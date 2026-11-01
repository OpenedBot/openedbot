package commands

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

const macDoctorLsofCommand = "/usr/sbin/lsof -nP -a -iTCP:8642 -sTCP:LISTEN -Ffn"

type macDoctorGatewayFake struct {
	healthStatus int
	healthErr    error
	anonymousErr error
	toolsets     []string
	toolsetsErr  error
}

func (f *macDoctorGatewayFake) Health(context.Context) (int, error) {
	return f.healthStatus, f.healthErr
}

func (f *macDoctorGatewayFake) RequireUnauthorizedWithoutBearer(context.Context) error {
	return f.anonymousErr
}

func (f *macDoctorGatewayFake) Toolsets(context.Context) ([]string, error) {
	return f.toolsets, f.toolsetsErr
}

type macDoctorTestFixture struct {
	home       string
	paths      layout.MacRuntimePaths
	runner     *exectest.Fake
	store      *macStatusStoreFake
	gateway    *macDoctorGatewayFake
	deps       macDoctorDeps
	readyPaths []string
}

func newMacDoctorTestFixture(t *testing.T) *macDoctorTestFixture {
	t.Helper()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS paths")
	}
	runner := macStatusLaunchdFake()
	prepareMacStatusGlobals(t, paths, runner)
	saveMacStatusState(t, paths)
	store := &macStatusStoreFake{}
	gatewayFake := &macDoctorGatewayFake{healthStatus: 200, toolsets: []string{}}
	fixture := &macDoctorTestFixture{home: home, paths: paths, runner: runner, store: store, gateway: gatewayFake}
	config := operator.MacCommand(paths, home, "hermes", "config", "get", "gateway.multiplex_profiles")
	runner.On(config.String(), exec.Result{Stdout: "true\n"})
	runner.On(macDoctorLsofCommand, exec.Result{Stdout: "p731\nf4\nn127.0.0.1:8642\n"})
	fixture.deps = macDoctorDeps{
		Store: store, Gateway: gatewayFake,
		OperatorReady: func(_ context.Context, path string) error {
			fixture.readyPaths = append(fixture.readyPaths, path)
			return nil
		},
	}
	return fixture
}

func assertMacDoctorDoesNotLeak(t *testing.T, problems, warnings []string, secrets ...string) {
	t.Helper()
	text := strings.Join(append(append([]string{}, problems...), warnings...), "\n")
	for _, secret := range secrets {
		if strings.Contains(text, secret) {
			t.Fatal("doctor output included an external error, refusal reason, link token, or seed")
		}
	}
}

func TestCollectMacDoctorHealthyRuntimeWithoutLinkReturnsOnlyWarnings(t *testing.T) {
	f := newMacDoctorTestFixture(t)
	problems, warnings := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
	if len(problems) != 0 {
		t.Fatalf("healthy fake runtime returned problems: %v", problems)
	}
	if !containsMacDoctorLine(warnings, "Linux host-policy and rootless-Docker checks are unavailable on macOS") ||
		!containsMacDoctorLine(warnings, "no connector link yet: run edge-setup link and enter its ticket at the hidden prompt") {
		t.Fatal("healthy runtime should retain the platform warning and the no-link warning")
	}
	if len(f.readyPaths) != 1 || f.readyPaths[0] != f.paths.OperatorSocket {
		t.Fatal("doctor did not prove operator readiness at the private managed socket path")
	}
	if !f.runner.Ran(macDoctorLsofCommand) {
		t.Fatal("doctor did not inspect the gateway listener through the fake lsof runner")
	}
	config := operator.MacCommand(f.paths, f.home, "hermes", "config", "get", "gateway.multiplex_profiles")
	if !f.runner.Ran(config.String()) {
		t.Fatal("doctor did not read back gateway.multiplex_profiles through the fixed Hermes CLI command")
	}
}

func containsMacDoctorLine(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}

func TestCollectMacDoctorReportsMissingServiceAndPublicListener(t *testing.T) {
	t.Run("missing gateway service", func(t *testing.T) {
		f := newMacDoctorTestFixture(t)
		target := "/bin/launchctl print gui/" + fmtUID(os.Geteuid()) + "/com.openhermesbot.edge-setup.gateway"
		f.runner.On(target, exec.Result{ExitCode: 113, Stderr: "Could not find service"})
		problems, _ := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
		if !containsMacDoctorLine(problems, "openedbot gateway LaunchAgent is not active") {
			t.Fatal("missing LaunchAgent was not reported as inactive")
		}
	})

	t.Run("public listener", func(t *testing.T) {
		f := newMacDoctorTestFixture(t)
		f.runner.On(macDoctorLsofCommand, exec.Result{Stdout: "p731\nf4\nn*:8642\n"})
		problems, _ := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
		if !containsMacDoctorLine(problems, "gateway has a listener outside loopback") {
			t.Fatal("public wildcard listener was not rejected")
		}
	})
}

func TestCollectMacDoctorLsofFailureIsGenericAndMultiplexMustBeTrue(t *testing.T) {
	t.Run("unknown lsof transcript", func(t *testing.T) {
		f := newMacDoctorTestFixture(t)
		secret := "fixture-lsof-secret-transcript"
		f.runner.On(macDoctorLsofCommand, exec.Result{ExitCode: 1, Stderr: secret})
		problems, warnings := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
		if !containsMacDoctorLine(problems, "gateway listener inspection did not prove a loopback listener") {
			t.Fatal("failed lsof inspection was not reported as unproven")
		}
		assertMacDoctorDoesNotLeak(t, problems, warnings, secret)
	})

	t.Run("successful lsof with diagnostic stderr", func(t *testing.T) {
		f := newMacDoctorTestFixture(t)
		secret := "fixture-lsof-stderr-secret"
		f.runner.On(macDoctorLsofCommand, exec.Result{Stdout: "p731\nf4\nn127.0.0.1:8642\n", Stderr: secret})
		problems, warnings := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
		if !containsMacDoctorLine(problems, "gateway listener inspection did not prove a loopback listener") {
			t.Fatal("non-empty lsof diagnostics were treated as a verified listener")
		}
		assertMacDoctorDoesNotLeak(t, problems, warnings, secret)
	})

	t.Run("multiplex readback false", func(t *testing.T) {
		f := newMacDoctorTestFixture(t)
		config := operator.MacCommand(f.paths, f.home, "hermes", "config", "get", "gateway.multiplex_profiles")
		f.runner.On(config.String(), exec.Result{Stdout: "false\n"})
		problems, _ := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
		if !containsMacDoctorLine(problems, "gateway.multiplex_profiles = true could not be confirmed") {
			t.Fatal("doctor accepted a false multiplex profile readback")
		}
	})
}

func TestCollectMacDoctorGatewayAndOperatorProofErrorsStayGeneric(t *testing.T) {
	f := newMacDoctorTestFixture(t)
	secret := "fixture-upstream-error-secret"
	f.gateway.healthStatus = 500
	f.gateway.healthErr = errors.New(secret + " health detail")
	f.gateway.anonymousErr = errors.New(secret + " anonymous detail")
	f.gateway.toolsetsErr = errors.New(secret + " toolset detail")
	f.deps.OperatorReady = func(context.Context, string) error { return errors.New(secret + " operator detail") }
	problems, warnings := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
	for _, want := range []string{
		"loopback gateway health could not be confirmed",
		"loopback gateway did not prove refusal of anonymous calls",
		"loopback gateway toolsets could not be read back",
		"operator did not prove the required runtime capabilities",
	} {
		if !containsMacDoctorLine(problems, want) {
			t.Errorf("generic proof problem %q was not reported", want)
		}
	}
	assertMacDoctorDoesNotLeak(t, problems, warnings, secret)

	f.gateway.healthErr = nil
	f.gateway.healthStatus = 200
	f.gateway.anonymousErr = nil
	f.gateway.toolsetsErr = nil
	f.gateway.toolsets = []string{pins.ForbiddenToolsets[0]}
	problems, _ = collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
	if !containsMacDoctorLine(problems, "loopback gateway toolset policy did not read back as requested") {
		t.Fatal("doctor did not reject a forbidden enabled toolset")
	}
}

func TestCollectMacDoctorReportsInaccessibleRefusedLinkedInstanceWithoutRawDetails(t *testing.T) {
	f := newMacDoctorTestFixture(t)
	if err := os.MkdirAll(f.paths.ConnectorRoot, 0o700); err != nil {
		t.Fatal("could not create temporary connector root")
	}
	if err := os.Chmod(f.paths.ConnectorRoot, 0o700); err != nil {
		t.Fatal("could not make temporary connector root private")
	}
	saveMacStatusLink(t, layout.DefaultConnectorInstance, f.paths, "runtime-default")
	stateDir := filepath.Join(f.paths.StateRoot)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal("could not create temporary connector state root")
	}
	refusalSecret := "fixture-refusal-reason-secret"
	if err := fsx.WriteAtomic(filepath.Join(stateDir, linkRefusedMarker), []byte("reason="+refusalSecret+"\n"), 0o600, fsx.Current()); err != nil {
		t.Fatal("could not write temporary refusal marker")
	}
	keychainSecret := "fixture-keychain-error-secret"
	f.store.errs = map[layout.ConnectorInstance]error{layout.DefaultConnectorInstance: errors.New(keychainSecret)}
	problems, warnings := collectMacDoctor(context.Background(), f.home, f.paths, f.deps)
	if !containsMacDoctorLine(problems, "connector default was refused by openedbot; pair it again") ||
		!containsMacDoctorLine(problems, "connector default device key is inaccessible") {
		t.Fatal("linked instance refusal and unavailable Keychain identity were not reported")
	}
	assertMacDoctorDoesNotLeak(t, problems, warnings, refusalSecret, keychainSecret, "fixture-link-token-never-return-this")
}

func TestRequireMacLoopbackListenersValidatesFieldOrderAndNumericAddresses(t *testing.T) {
	for _, tc := range []struct {
		name    string
		output  string
		wantErr bool
	}{
		{name: "IPv4 loopback", output: "p731\nf4\nn127.0.0.1:8642\n"},
		{name: "IPv6 loopback", output: "p731\nf5\nn[::1]:8642\n"},
		{name: "multiple files and processes", output: "p731\nf4\nn127.0.0.1:8642\np812\nf7\nn[::1]:8642\n"},
		{name: "wildcard listener", output: "p731\nf4\nn*:8642\n", wantErr: true},
		{name: "public IPv4 listener", output: "p731\nf4\nn203.0.113.10:8642\n", wantErr: true},
		{name: "missing process id", output: "f4\nn127.0.0.1:8642\n", wantErr: true},
		{name: "missing file descriptor", output: "p731\nn127.0.0.1:8642\n", wantErr: true},
		{name: "missing name", output: "p731\nf4\n", wantErr: true},
		{name: "invalid process id", output: "p0\nf4\nn127.0.0.1:8642\n", wantErr: true},
		{name: "non-numeric process id", output: "p731x\nf4\nn127.0.0.1:8642\n", wantErr: true},
		{name: "non-numeric file descriptor", output: "p731\nf4x\nn127.0.0.1:8642\n", wantErr: true},
		{name: "negative file descriptor", output: "p731\nf-1\nn127.0.0.1:8642\n", wantErr: true},
		{name: "missing descriptor before next process", output: "p731\np812\nf7\nn127.0.0.1:8642\n", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireMacLoopbackListeners(tc.output)
			if (err != nil) != tc.wantErr {
				t.Fatalf("listener parse error = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}

func fmtUID(uid int) string { return fmt.Sprintf("%d", uid) }
