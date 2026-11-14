package operator

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const macTestGatewayToken = "0123456789abcdef0123456789abcdef"

func macTestPaths(t *testing.T) (string, layout.MacRuntimePaths) {
	t.Helper()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive the temporary managed macOS runtime paths")
	}
	return home, paths
}

func writeMacTestHermesCLI(t *testing.T, paths layout.MacRuntimePaths, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(paths.VenvBin, 0o700); err != nil {
		t.Fatal("could not create temporary venv directory")
	}
	path := filepath.Join(paths.VenvBin, "hermes")
	if err := os.WriteFile(path, []byte("fixture executable, never launched"), 0o600); err != nil {
		t.Fatal("could not create inert Hermes CLI fixture")
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal("could not set inert Hermes CLI fixture mode")
	}
}

func newMacHostForTest(t *testing.T, runner exec.Runner, home string, paths layout.MacRuntimePaths) (*Server, error) {
	t.Helper()
	return MacHost(runner, macTestGatewayToken, MacHostConfig{
		Paths: paths,
		Home:  home,
		Token: func() (string, error) { return macTestGatewayToken, nil },
	}, nil)
}

func capabilityFeatures(t *testing.T, server *Server) []string {
	t.Helper()
	request := httptest.NewRequest("GET", "/capabilities", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("capability handler status = %d", response.Code)
	}
	var body struct {
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal("capability handler returned invalid JSON")
	}
	return body.Features
}

func hasMacFeature(features []string, want string) bool {
	for _, feature := range features {
		if feature == want {
			return true
		}
	}
	return false
}

func TestMacHostRejectsForeignPathsAndUnusableHermesCLI(t *testing.T) {
	home, paths := macTestPaths(t)
	writeMacTestHermesCLI(t, paths, 0o755)
	changed := paths
	changed.RuntimeRoot = filepath.Join(paths.RuntimeRoot, "other")
	if _, err := newMacHostForTest(t, exectest.NewFake(), home, changed); err == nil {
		t.Fatal("paths outside the derived managed runtime were accepted")
	}

	if err := os.Remove(filepath.Join(paths.VenvBin, "hermes")); err != nil {
		t.Fatal("could not remove inert CLI fixture")
	}
	if _, err := newMacHostForTest(t, exectest.NewFake(), home, paths); err == nil {
		t.Fatal("missing CLI was accepted")
	}
	writeMacTestHermesCLI(t, paths, 0o600)
	if _, err := newMacHostForTest(t, exectest.NewFake(), home, paths); err == nil {
		t.Fatal("non-executable CLI was accepted")
	}
	if err := os.Remove(filepath.Join(paths.VenvBin, "hermes")); err != nil {
		t.Fatal("could not remove inert CLI fixture")
	}
	if err := os.Symlink("/bin/true", filepath.Join(paths.VenvBin, "hermes")); err != nil {
		t.Fatal("could not create inert symlink fixture")
	}
	if _, err := newMacHostForTest(t, exectest.NewFake(), home, paths); err == nil {
		t.Fatal("symlinked CLI was accepted")
	}
}

func TestMacHostPersistsSkillOperationsUnderManagedStateRoot(t *testing.T) {
	home, paths := macTestPaths(t)
	writeMacTestHermesCLI(t, paths, 0o755)
	server, err := newMacHostForTest(t, exectest.NewFake(), home, paths)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(paths.StateRoot, "skills-hub-operations")
	if got := server.skillOperationDir(); got != want {
		t.Fatalf("macOS skill operation directory = %q, want %q", got, want)
	}
}

func TestMacHostOmitsFeaturesForMissingOrChangedProbes(t *testing.T) {
	t.Run("missing inventory probe", func(t *testing.T) {
		home, paths := macTestPaths(t)
		writeMacTestHermesCLI(t, paths, 0o755)
		server, err := newMacHostForTest(t, exectest.NewFake(), home, paths)
		if err != nil {
			t.Fatal("missing optional probes prevented the operator from starting")
		}
		features := capabilityFeatures(t, server)
		for _, omitted := range []string{"toolset_management", "mcp_management", "profile_inventory", "profile_credentials", "mcp_oauth"} {
			if hasMacFeature(features, omitted) {
				t.Fatalf("missing inventory probe advertised %q", omitted)
			}
		}
	})

	t.Run("mutated inventory probe", func(t *testing.T) {
		home, paths := macTestPaths(t)
		writeMacTestHermesCLI(t, paths, 0o755)
		if err := InstallMacProbe(paths); err != nil {
			t.Fatal("could not install temporary probe fixtures")
		}
		if err := os.WriteFile(paths.Probe, []byte("changed probe"), 0o600); err != nil {
			t.Fatal("could not mutate temporary probe fixture")
		}
		server, err := newMacHostForTest(t, exectest.NewFake(), home, paths)
		if err != nil {
			t.Fatal("mutated optional probe prevented the operator from starting")
		}
		features := capabilityFeatures(t, server)
		if hasMacFeature(features, "toolset_management") || hasMacFeature(features, "profile_inventory") {
			t.Fatal("mutated inventory probe left inventory features enabled")
		}
	})

	t.Run("mutated OAuth probe", func(t *testing.T) {
		home, paths := macTestPaths(t)
		writeMacTestHermesCLI(t, paths, 0o755)
		if err := InstallMacProbe(paths); err != nil {
			t.Fatal("could not install temporary probe fixtures")
		}
		if err := os.WriteFile(paths.OAuthProbe, []byte("changed OAuth probe"), 0o600); err != nil {
			t.Fatal("could not mutate temporary OAuth probe fixture")
		}
		fake := exectest.NewFake().OnPrefix(filepath.Join(paths.VenvBin, "python")+" "+paths.Probe+" profiles", exec.Result{Stdout: `{"multiplex":false,"profiles":[]}`})
		server, err := newMacHostForTest(t, fake, home, paths)
		if err != nil {
			t.Fatal("mutated OAuth probe prevented the operator from starting")
		}
		features := capabilityFeatures(t, server)
		if !hasMacFeature(features, "mcp_management") || hasMacFeature(features, "mcp_oauth") {
			t.Fatal("OAuth probe mutation did not omit only the OAuth feature")
		}
	})
}

func TestMacHostRefreshesProfileFeaturesFromCurrentMultiplexSetting(t *testing.T) {
	home, paths := macTestPaths(t)
	writeMacTestHermesCLI(t, paths, 0o755)
	if err := InstallMacProbe(paths); err != nil {
		t.Fatal("could not install temporary probe fixtures")
	}
	command := filepath.Join(paths.VenvBin, "python") + " " + paths.Probe + " profiles"
	fake := exectest.NewFake().OnSequence(command,
		exec.Result{Stdout: `{"multiplex":true,"profiles":[]}`},
		exec.Result{Stdout: `{"multiplex":false,"profiles":[]}`},
	)
	server, err := newMacHostForTest(t, fake, home, paths)
	if err != nil {
		t.Fatal("managed macOS operator construction failed")
	}
	if !hasMacFeature(server.features(), "profile_credentials") {
		t.Fatal("initial multiplex profile setting was not reflected")
	}
	features := capabilityFeatures(t, server)
	for _, omitted := range []string{"profile_management", "profile_capabilities", "profile_credentials", "profile_memory"} {
		if hasMacFeature(features, omitted) {
			t.Fatalf("current multiplex=false setting retained %q", omitted)
		}
	}
}

func TestMacCommandUsesPrivateRuntimeAndKeepsInputOffArgvAndEnvironment(t *testing.T) {
	home, paths := macTestPaths(t)
	secret := "fixture-secret-never-log"
	for _, program := range []string{"python", "hermes"} {
		cmd := MacCommand(paths, home, program, "-p", "scout", "auth", "add")
		cmd.Stdin = []byte(secret + "\n")
		if cmd.Path != filepath.Join(paths.VenvBin, program) || cmd.Dir != paths.RuntimeRoot {
			t.Fatalf("fixed %s command did not use the managed runtime paths", program)
		}
		joined := cmd.String() + "\n" + strings.Join(cmd.Env, "\n")
		if strings.Contains(joined, secret) || strings.Contains(cmd.String(), secret) {
			t.Fatalf("fixed %s command exposed stdin input through argv or environment", program)
		}
		if string(cmd.Stdin) != secret+"\n" {
			t.Fatalf("fixed %s command did not preserve its stdin input", program)
		}
		if !strings.Contains(joined, "HERMES_HOME="+paths.RuntimeRoot) || !strings.Contains(joined, "HOME="+home) {
			t.Fatalf("fixed %s command omitted its private runtime homes", program)
		}
		wantPath := "PATH=" + paths.VenvBin + ":" + paths.NodeBin + ":"
		if !strings.Contains(joined, wantPath) {
			t.Fatalf("fixed %s command omitted the pinned Node path", program)
		}
	}
}

func TestMacHostRunsOnlyClosedHermesAndPythonCommandsThroughRunner(t *testing.T) {
	home, paths := macTestPaths(t)
	writeMacTestHermesCLI(t, paths, 0o755)
	if err := InstallMacProbe(paths); err != nil {
		t.Fatal("could not install temporary probe fixtures")
	}
	fake := exectest.NewFake().OnPrefix(filepath.Join(paths.VenvBin, "python")+" "+paths.Probe+" profiles", exec.Result{Stdout: `{"multiplex":false,"profiles":[]}`})
	server, err := newMacHostForTest(t, fake, home, paths)
	if err != nil {
		t.Fatal("managed macOS operator construction failed")
	}
	server.refreshMultiplex(context.Background())
	for _, call := range fake.Calls {
		if call.Path != filepath.Join(paths.VenvBin, "python") {
			t.Fatalf("probe attempted an unexpected executable %q", filepath.Base(call.Path))
		}
	}
	if server.HermesCommand == nil || server.HermesCommand("auth", "add", "anthropic").Path != filepath.Join(paths.VenvBin, "hermes") {
		t.Fatal("Hermes credential commands do not use the managed Hermes CLI")
	}
}
