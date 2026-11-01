package commands

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
)

const runtimeCLITestToken = "0123456789abcdef0123456789abcdef"

func newRuntimeCLIMacTest(t *testing.T, runner exec.Runner) (string, layout.MacRuntimePaths, runtimeCLI) {
	t.Helper()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS runtime paths")
	}
	host, err := runtimeCLIFor("darwin", home, runner)
	if err != nil {
		t.Fatal("could not construct macOS runtime CLI")
	}
	return home, paths, host
}

func writeRuntimeCLITestFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal("could not create private temporary runtime directory")
	}
	if err := fsx.WriteAtomic(path, data, mode, fsx.Current()); err != nil {
		t.Fatal("could not write temporary private runtime file")
	}
}

func installRuntimeCLITestHermes(t *testing.T, paths layout.MacRuntimePaths) {
	t.Helper()
	if err := os.MkdirAll(paths.VenvBin, 0o700); err != nil {
		t.Fatal("could not create temporary Hermes venv directory")
	}
	path := filepath.Join(paths.VenvBin, "hermes")
	if err := os.WriteFile(path, []byte("inert fixture, never executed"), 0o600); err != nil {
		t.Fatal("could not create inert Hermes CLI fixture")
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal("could not mark inert Hermes CLI fixture executable")
	}
}

func writeRuntimeCLITestToken(t *testing.T, paths layout.MacRuntimePaths, token string, mode os.FileMode) {
	t.Helper()
	writeRuntimeCLITestFile(t, paths.RuntimeEnv, []byte("API_SERVER_KEY="+token+"\n"), mode)
}

func TestRuntimeCLIForMacCommandAndCredentialStoreStayInsidePrivateRuntime(t *testing.T) {
	fake := exectest.NewFake()
	home, paths, host := newRuntimeCLIMacTest(t, fake)
	if _, err := os.Lstat(paths.AppRoot); !os.IsNotExist(err) {
		t.Fatal("runtime CLI construction changed the filesystem")
	}
	if paths.RuntimeRoot == layout.RuntimeRoot {
		t.Fatal("macOS runtime CLI reused the legacy Linux runtime root")
	}
	if store, ok := host.Env.(hermes.EnvStore); !ok || store.Root != paths.RuntimeRoot || store.Owner != fsx.Current() {
		t.Fatal("macOS credentials do not use the current user's private runtime store")
	}
	writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o600)
	if got, err := host.Token(); err != nil || got != runtimeCLITestToken {
		t.Fatal("macOS CLI factory did not read its private runtime token")
	}
	if host.RestartMarker != paths.RestartMarker {
		t.Fatal("macOS runtime CLI restart marker is not scoped to the managed runtime")
	}
	secret := "fixture-command-secret-never-in-argv-or-env"
	cmd := host.Command("auth", "add", "anthropic")
	cmd.Stdin = []byte(secret + "\n")
	wantPath := filepath.Join(paths.VenvBin, "hermes")
	wantArgs := []string{"auth", "add", "anthropic"}
	if cmd.Path != wantPath || cmd.Dir != paths.RuntimeRoot || !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatal("macOS CLI command differs from the fixed managed Hermes invocation")
	}
	encodedCommand := cmd.String() + "\n" + strings.Join(cmd.Env, "\n")
	if strings.Contains(encodedCommand, secret) || string(cmd.Stdin) != secret+"\n" {
		t.Fatal("CLI input did not remain on stdin")
	}
	for _, want := range []string{
		"HERMES_HOME=" + paths.RuntimeRoot,
		"HOME=" + home,
		"PATH=" + paths.VenvBin + ":" + paths.NodeBin + ":",
	} {
		if !strings.Contains(encodedCommand, want) {
			t.Fatal("macOS CLI environment omitted its dedicated runtime path")
		}
	}
	if strings.Contains(encodedCommand, runtimeCLITestToken) {
		t.Fatal("gateway token appeared in the Hermes CLI command")
	}
	python := host.Python("-c", "print(1)")
	if python.Path != filepath.Join(paths.VenvBin, "python") || !reflect.DeepEqual(python.Args, []string{"-c", "print(1)"}) || python.Dir != paths.RuntimeRoot {
		t.Fatal("macOS Python command differs from the fixed private runtime invocation")
	}
	pythonEnv := python.String() + "\n" + strings.Join(python.Env, "\n")
	if !strings.Contains(pythonEnv, "HERMES_HOME="+paths.RuntimeRoot) || !strings.Contains(pythonEnv, "PATH="+paths.VenvBin+":"+paths.NodeBin+":") || strings.Contains(pythonEnv, runtimeCLITestToken) {
		t.Fatal("macOS Python command omitted its private paths or exposed the gateway token")
	}
	if len(fake.Calls) != 0 {
		t.Fatal("runtime CLI construction or command rendering invoked its runner")
	}
}

func TestRuntimeCLIMacEnvSnapshotsAndMirrorsOnlyWithinManagedRuntime(t *testing.T) {
	_, paths, host := newRuntimeCLIMacTest(t, exectest.NewFake())
	rootEnv := filepath.Join(paths.RuntimeRoot, ".env")
	writeRuntimeCLITestFile(t, rootEnv, []byte("API_SERVER_KEY=root-token\nANTHROPIC_API_KEY=root-old\n"), 0o600)
	writeRuntimeCLITestFile(t, filepath.Join(paths.RuntimeRoot, "profiles", "personal", ".env"), []byte("ANTHROPIC_API_KEY=personal-owned\nKEEP=personal\n"), 0o600)
	writeRuntimeCLITestFile(t, filepath.Join(paths.RuntimeRoot, "profiles", "personal", ".env.ohb-own"), []byte("ANTHROPIC_API_KEY\n"), 0o600)
	writeRuntimeCLITestFile(t, filepath.Join(paths.RuntimeRoot, "profiles", "team", ".env"), []byte("KEEP=team\n"), 0o600)

	before, err := host.Env.SnapshotRootEnv()
	if err != nil || before["ANTHROPIC_API_KEY"] != "root-old" || before["API_SERVER_KEY"] != "root-token" {
		t.Fatal("macOS environment snapshot did not read the configured runtime root")
	}
	profile, err := host.Env.SnapshotProfileEnv("personal")
	if err != nil || profile["ANTHROPIC_API_KEY"] != "personal-owned" {
		t.Fatal("macOS environment snapshot did not read the named profile in its managed root")
	}
	writeRuntimeCLITestFile(t, rootEnv, []byte("API_SERVER_KEY=rotated-root-token\nANTHROPIC_API_KEY=root-new\n"), 0o600)
	after, err := host.Env.SnapshotRootEnv()
	if err != nil {
		t.Fatal("updated root environment could not be read")
	}
	if err := mirrorRuntimeCLI(host, before); err != nil {
		t.Fatal("managed runtime credential delta could not be mirrored")
	}
	personal, err := os.ReadFile(filepath.Join(paths.RuntimeRoot, "profiles", "personal", ".env"))
	if err != nil || !strings.Contains(string(personal), "ANTHROPIC_API_KEY=personal-owned") {
		t.Fatal("root credential mirroring overwrote a profile-owned credential")
	}
	team, err := os.ReadFile(filepath.Join(paths.RuntimeRoot, "profiles", "team", ".env"))
	if err != nil || !strings.Contains(string(team), "ANTHROPIC_API_KEY=root-new") || strings.Contains(string(team), "API_SERVER_KEY=") {
		t.Fatal("mirroring escaped provider credential scope or copied the root gateway key")
	}
	if after["ANTHROPIC_API_KEY"] != "root-new" || after["API_SERVER_KEY"] != "rotated-root-token" {
		t.Fatal("root snapshot did not reflect the fixture update")
	}
}

func TestRuntimeCLIMacTokenRequiresPrivateValidOwnedFile(t *testing.T) {
	t.Run("valid token", func(t *testing.T) {
		_, paths, host := newRuntimeCLIMacTest(t, exectest.NewFake())
		writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o600)
		got, err := host.Token()
		if err != nil || got != runtimeCLITestToken {
			t.Fatal("private valid gateway credential was not read")
		}
	})

	t.Run("missing token", func(t *testing.T) {
		_, _, host := newRuntimeCLIMacTest(t, exectest.NewFake())
		if _, err := host.Token(); err == nil {
			t.Fatal("missing gateway credential was accepted")
		}
	})

	t.Run("wrong mode", func(t *testing.T) {
		_, paths, host := newRuntimeCLIMacTest(t, exectest.NewFake())
		writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o644)
		if _, err := host.Token(); err == nil {
			t.Fatal("non-private gateway credential was accepted")
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		_, paths, host := newRuntimeCLIMacTest(t, exectest.NewFake())
		writeRuntimeCLITestToken(t, paths, "not-a-hex-token", 0o600)
		if _, err := host.Token(); err == nil {
			t.Fatal("invalid gateway credential was accepted")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		_, paths, host := newRuntimeCLIMacTest(t, exectest.NewFake())
		target := filepath.Join(t.TempDir(), "token-target")
		if err := os.WriteFile(target, []byte("API_SERVER_KEY="+runtimeCLITestToken+"\n"), 0o600); err != nil {
			t.Fatal("could not write temporary token target")
		}
		if err := os.MkdirAll(filepath.Dir(paths.RuntimeEnv), 0o700); err != nil {
			t.Fatal("could not create temporary token parent")
		}
		if err := os.Symlink(target, paths.RuntimeEnv); err != nil {
			t.Fatal("could not create temporary token symlink")
		}
		if _, err := host.Token(); err == nil {
			t.Fatal("symlinked gateway credential was accepted")
		}
	})
}

func TestRuntimeCLIForRejectsUnknownOSWithoutRunnerCalls(t *testing.T) {
	fake := exectest.NewFake()
	if _, err := runtimeCLIFor("plan9", t.TempDir(), fake); err == nil {
		t.Fatal("unknown operating system was accepted")
	}
	if len(fake.Calls) != 0 {
		t.Fatal("unknown operating system invoked the runner")
	}
}

func TestRuntimeCLIForLinuxPreservesLegacyCommandAndDependencies(t *testing.T) {
	fake := exectest.NewFake()
	host, err := runtimeCLIFor("linux", "", fake)
	if err != nil {
		t.Fatal("Linux runtime CLI construction failed")
	}
	got := host.Command("config", "get", "gateway.multiplex_profiles")
	want := hermes.CLI("config", "get", "gateway.multiplex_profiles")
	if !reflect.DeepEqual(got, want) {
		t.Fatal("Linux runtime CLI changed its legacy Hermes command")
	}
	python := hermes.CLIWith(filepath.Join(layout.VenvBin, "python"), "-c", "print(1)")
	if _, ok := host.Env.(legacyCredentialEnv); !ok || host.Token == nil || host.Login == nil || host.Probe == nil || host.RestartMarker != layout.GatewayRestartMarker {
		t.Fatal("Linux runtime CLI did not preserve its legacy environment, token, login, and probe dependencies")
	}
	if got := host.Python("-c", "print(1)"); !reflect.DeepEqual(got, python) {
		t.Fatal("Linux runtime CLI changed its legacy venv Python command")
	}
	if len(fake.Calls) != 0 {
		t.Fatal("Linux runtime CLI construction invoked the runner")
	}
}

func TestRuntimeCLIMacProbeRequiresInstalledUnchangedProgramsAndUsesPythonOnStdin(t *testing.T) {
	t.Run("missing probe", func(t *testing.T) {
		runner := exectest.NewFake()
		_, paths, host := newRuntimeCLIMacTest(t, runner)
		installRuntimeCLITestHermes(t, paths)
		writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o600)
		if _, err := host.Probe(); err == nil || err.Error() != "private macOS inventory program is missing or changed; run edge-setup up" {
			t.Fatal("missing macOS probe was accepted or returned a non-generic refusal")
		}
		if len(runner.Calls) != 0 {
			t.Fatal("missing probe caused an external command to run")
		}
	})

	t.Run("mutated probe", func(t *testing.T) {
		runner := exectest.NewFake()
		_, paths, host := newRuntimeCLIMacTest(t, runner)
		installRuntimeCLITestHermes(t, paths)
		writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o600)
		if err := operator.InstallMacProbe(paths); err != nil {
			t.Fatal("could not install temporary embedded probe fixtures")
		}
		if err := os.WriteFile(paths.Probe, []byte("changed probe"), 0o600); err != nil {
			t.Fatal("could not mutate temporary probe fixture")
		}
		if _, err := host.Probe(); err == nil || err.Error() != "private macOS inventory program is missing or changed; run edge-setup up" {
			t.Fatal("mutated macOS probe was accepted or returned a non-generic refusal")
		}
		if len(runner.Calls) != 0 {
			t.Fatal("mutated probe check ran the interpreter")
		}
	})

	t.Run("fixed python command and secret stdin", func(t *testing.T) {
		runner := exectest.NewFake()
		_, paths, host := newRuntimeCLIMacTest(t, runner)
		installRuntimeCLITestHermes(t, paths)
		writeRuntimeCLITestToken(t, paths, runtimeCLITestToken, 0o600)
		if err := operator.InstallMacProbe(paths); err != nil {
			t.Fatal("could not install temporary embedded probe fixtures")
		}
		command := filepath.Join(paths.VenvBin, "python") + " " + paths.Probe + " profiles"
		runner.OnSequence(command,
			exec.Result{Stdout: `{"multiplex":false,"profiles":[]}`},
			exec.Result{Stdout: `{"multiplex":false,"profiles":[]}`},
		)
		probe, err := host.Probe()
		if err != nil {
			t.Fatal("unchanged temporary macOS probe was not enabled")
		}
		secret := "fixture-probe-secret-only-on-stdin"
		request := []byte(`{"name":"fixture","apiKey":"` + secret + `"}`)
		got, err := probe(context.Background(), "profiles", request)
		if err != nil || string(got) != `{"multiplex":false,"profiles":[]}` {
			t.Fatal("fake Python probe invocation failed")
		}
		if len(runner.Calls) != 2 {
			t.Fatalf("Python probe command count = %d, want one refresh and one probe", len(runner.Calls))
		}
		for index, call := range runner.Calls {
			if call.Path != filepath.Join(paths.VenvBin, "python") || !reflect.DeepEqual(call.Args, []string{paths.Probe, "profiles"}) || call.Dir != paths.RuntimeRoot {
				t.Fatal("inventory program did not use the fixed managed Python invocation")
			}
			if strings.Contains(call.String(), secret) || strings.Contains(strings.Join(call.Env, "\n"), secret) {
				t.Fatal("probe request secret escaped into argv or environment")
			}
			if index == 0 && !bytes.Equal(call.Stdin, []byte(`{}`)) {
				t.Fatal("initial multiplex refresh did not use an empty probe request")
			}
			if index == 1 && !bytes.Equal(call.Stdin, request) {
				t.Fatal("probe request was not transported on stdin")
			}
		}
	})
}
