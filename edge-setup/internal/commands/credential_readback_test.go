package commands

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const readbackProvider = "anthropic"
const readbackLabel = "managed-key"

func readbackTestHost(fake *exectest.Fake) runtimeCLI {
	return runtimeCLI{Python: func(args ...string) exec.Cmd {
		return exec.Cmd{Path: "/tmp/fixture/venv/bin/python", Args: append([]string(nil), args...), Dir: "/tmp/fixture/runtime", Env: []string{"HERMES_HOME=/tmp/fixture/runtime"}}
	}}
}

func TestProveCredentialRemovedUsesExactLabelAbsence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		stdout  string
		wantErr bool
	}{
		{name: "exact label still present", stdout: `{"labels":["other","managed-key"]}`, wantErr: true},
		{name: "partial homonym is distinct", stdout: `{"labels":["managed-key-backup","prefix-managed-key"]}`},
		{name: "empty pool", stdout: `{"labels":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := exectest.NewFake()
			host := readbackTestHost(fake)
			cmd := host.Python("-c", credentialLabelsProgram, readbackProvider)
			fake.On(cmd.String(), exec.Result{Stdout: tc.stdout})
			err := proveCredentialRemoved(context.Background(), fake, host, readbackProvider, readbackLabel)
			if (err != nil) != tc.wantErr {
				t.Fatalf("proof error = %v, want error %v", err, tc.wantErr)
			}
			if len(fake.Calls) != 1 {
				t.Fatal("credential pool was not read exactly once")
			}
			if fake.Calls[0].Timeout != 15*time.Second {
				t.Fatal("credential readback command lacks its bounded deadline")
			}
		})
	}
}

func TestProveCredentialRemovedRejectsMalformedOrUnboundedReadback(t *testing.T) {
	for _, tc := range []struct {
		name   string
		stdout string
	}{
		{name: "malformed JSON", stdout: `{`},
		{name: "unknown field", stdout: `{"labels":[],"secret":"must not be accepted"}`},
		{name: "null labels", stdout: `{"labels":null}`},
		{name: "null label entry", stdout: `{"labels":[null]}`},
		{name: "trailing JSON", stdout: `{"labels":[]} {"labels":[]}`},
		{name: "oversized output", stdout: strings.Repeat("x", (256<<10)+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := exectest.NewFake()
			host := readbackTestHost(fake)
			cmd := host.Python("-c", credentialLabelsProgram, readbackProvider)
			fake.On(cmd.String(), exec.Result{Stdout: tc.stdout})
			err := proveCredentialRemoved(context.Background(), fake, host, readbackProvider, readbackLabel)
			if err == nil || !strings.Contains(err.Error(), "readback is invalid") && !strings.Contains(err.Error(), "could not be read back") {
				t.Fatal("invalid or oversized credential readback was accepted")
			}
			if len(fake.Calls) != 1 {
				t.Fatal("credential readback command was not bounded to one invocation")
			}
		})
	}
}

func TestProveCredentialRemovedSanitizesCommandFailure(t *testing.T) {
	secret := "fixture-auth-json-transcript-secret"
	fake := exectest.NewFake()
	host := readbackTestHost(fake)
	cmd := host.Python("-c", credentialLabelsProgram, readbackProvider)
	fake.On(cmd.String(), exec.Result{ExitCode: 1, Stderr: secret})
	err := proveCredentialRemoved(context.Background(), fake, host, readbackProvider, readbackLabel)
	if err == nil || err.Error() != "credential pool could not be read back; removal is unverified" || strings.Contains(err.Error(), secret) {
		t.Fatal("readback failure returned an upstream transcript or claimed removal")
	}
	if len(fake.Calls) != 1 {
		t.Fatal("credential pool failure was not produced by the single fake command")
	}
}

func TestProveCredentialRemovedRejectsDiagnosticStderrEvenOnSuccess(t *testing.T) {
	secret := "fixture-pool-stderr-secret"
	fake := exectest.NewFake()
	host := readbackTestHost(fake)
	cmd := host.Python("-c", credentialLabelsProgram, readbackProvider)
	fake.On(cmd.String(), exec.Result{Stdout: `{"labels":[]}`, Stderr: secret})
	err := proveCredentialRemoved(context.Background(), fake, host, readbackProvider, readbackLabel)
	if err == nil || err.Error() != "credential pool could not be read back; removal is unverified" || strings.Contains(err.Error(), secret) {
		t.Fatal("successful exit with diagnostics was treated as a verified removal or leaked stderr")
	}
}

type credentialReadbackErrorRunner func(context.Context, exec.Cmd) (exec.Result, error)

func (fn credentialReadbackErrorRunner) Run(ctx context.Context, cmd exec.Cmd) (exec.Result, error) {
	return fn(ctx, cmd)
}

func TestProveCredentialRemovedSanitizesRunnerError(t *testing.T) {
	secret := "fixture-process-error-secret"
	runner := credentialReadbackErrorRunner(func(context.Context, exec.Cmd) (exec.Result, error) {
		return exec.Result{}, errors.New(secret)
	})
	host := runtimeCLI{Python: func(args ...string) exec.Cmd {
		return exec.Cmd{Path: "/tmp/fixture/python", Args: args}
	}}
	err := proveCredentialRemoved(context.Background(), runner, host, readbackProvider, readbackLabel)
	if err == nil || err.Error() != "credential pool could not be read back; removal is unverified" || strings.Contains(err.Error(), secret) {
		t.Fatal("runner error transcript escaped the generic readback failure")
	}
}

func TestProveCredentialRemovedValidatesInputsBeforeCallingRunner(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider string
		label    string
		noPython bool
	}{
		{name: "invalid provider", provider: "../provider", label: readbackLabel},
		{name: "invalid label", provider: readbackProvider, label: "../label"},
		{name: "missing Python command", provider: readbackProvider, label: readbackLabel, noPython: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := exectest.NewFake()
			host := readbackTestHost(fake)
			if tc.noPython {
				host.Python = nil
			}
			if err := proveCredentialRemoved(context.Background(), fake, host, tc.provider, tc.label); err == nil {
				t.Fatal("invalid credential proof input was accepted")
			}
			if len(fake.Calls) != 0 {
				t.Fatal("invalid credential proof input reached the runner")
			}
		})
	}
}

func TestProveCredentialRemovedUsesManagedMacPythonContext(t *testing.T) {
	fake := exectest.NewFake()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS paths")
	}
	host, err := runtimeCLIFor("darwin", home, fake)
	if err != nil {
		t.Fatal("could not construct temporary macOS runtime CLI")
	}
	cmd := host.Python("-c", credentialLabelsProgram, readbackProvider)
	if cmd.Path != filepath.Join(paths.VenvBin, "python") || !reflect.DeepEqual(cmd.Args, []string{"-c", credentialLabelsProgram, readbackProvider}) || cmd.Dir != paths.RuntimeRoot {
		t.Fatal("readback does not use the pinned runtime Python invocation")
	}
	if !strings.Contains(strings.Join(cmd.Env, "\n"), "HERMES_HOME="+paths.RuntimeRoot) || !strings.Contains(strings.Join(cmd.Env, "\n"), "PATH="+paths.VenvBin+":"+paths.NodeBin+":") {
		t.Fatal("readback Python environment does not use the private macOS runtime")
	}
	if host.RestartMarker != paths.RestartMarker {
		t.Fatal("macOS runtime CLI restart marker is not derived from the managed runtime")
	}
	fake.On(cmd.String(), exec.Result{Stdout: `{"labels":[]}`})
	if err := proveCredentialRemoved(context.Background(), fake, host, readbackProvider, readbackLabel); err != nil {
		t.Fatal("managed macOS Python readback failed with the fake runner")
	}
	if len(fake.Calls) != 1 || fake.Calls[0].Path != filepath.Join(paths.VenvBin, "python") || fake.Calls[0].Timeout != 15*time.Second {
		t.Fatal("managed macOS readback did not use its fixed Python command and deadline")
	}
}
