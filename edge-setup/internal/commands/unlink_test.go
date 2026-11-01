package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type unlinkFixture struct {
	base              string
	instance          layout.ConnectorInstance
	owner             fsx.Owner
	files             []string
	link              string
	runtimeCredential string
	deviceKey         string
}

func newUnlinkFixture(t *testing.T, name string, withRuntimeCredential bool) unlinkFixture {
	t.Helper()
	base := redirectConnectorRoot(t)
	previousStateRoot := connectorStateRoot
	connectorStateRoot = filepath.Join(base, "connector-state")
	t.Cleanup(func() { connectorStateRoot = previousStateRoot })

	instance, err := layout.ParseConnectorInstance(name)
	if err != nil {
		t.Fatal(err)
	}
	fixture := unlinkFixture{
		base:      base,
		instance:  instance,
		owner:     connectorOwner,
		link:      linkPathOf(instance),
		deviceKey: deviceKeyPathOf(instance),
		files:     []string{linkPathOf(instance)},
	}
	if withRuntimeCredential {
		fixture.runtimeCredential = filepath.Join(instance.DirUnder(connectorRoot), "runtime.env")
		fixture.files = append(fixture.files, fixture.runtimeCredential)
	}
	fixture.files = append(fixture.files,
		filepath.Join(stateDirOf(instance), linkRefusedMarker),
		filepath.Join(stateDirOf(instance), linkAdmittedMarker),
		filepath.Join(stateDirOf(instance), "link-context.json"),
		filepath.Join(stateDirOf(instance), "link-token.json"),
	)
	for _, path := range append(append([]string{}, fixture.files...), fixture.deviceKey) {
		writeUnlinkFixtureFile(t, path)
	}
	return fixture
}

func writeUnlinkFixtureFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("test-only credential placeholder\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertUnlinkPathsPresent(t *testing.T, paths []string) {
	t.Helper()
	for _, path := range paths {
		if _, err := os.Lstat(path); err != nil {
			t.Errorf("expected path to remain before unlink completes: %s: %v", path, err)
		}
	}
}

func assertUnlinkPathsAbsent(t *testing.T, paths []string) {
	t.Helper()
	for _, path := range paths {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Errorf("expected path to be absent after unlink: %s, stat err=%v", path, err)
		}
	}
}

func unlinkTestDeps(f unlinkFixture, failAt string, requireFilesUntilDisable bool) (unlinkDeps, *[]string) {
	calls := []string{}
	step := func(name string) func(context.Context) error {
		return func(context.Context) error {
			calls = append(calls, name)
			if requireFilesUntilDisable {
				for _, path := range f.files {
					if _, err := os.Lstat(path); err != nil {
						return errors.New("credential disappeared before service proof completed")
					}
				}
			}
			if failAt == name {
				return errors.New("private callback failure detail")
			}
			return nil
		}
	}
	return unlinkDeps{
		Stop:                  step("stop"),
		Inactive:              step("inactive"),
		Disable:               step("disable"),
		RuntimeCredentialPath: f.runtimeCredential,
		StateOwner:            f.owner,
	}, &calls
}

func TestUnlinkInstancePreservesCredentialsWhenLifecycleProofFails(t *testing.T) {
	for _, stage := range []string{"stop", "inactive", "disable"} {
		t.Run(stage, func(t *testing.T) {
			fixture := newUnlinkFixture(t, "dev", true)
			other, err := layout.ParseConnectorInstance("prod")
			if err != nil {
				t.Fatal(err)
			}
			otherFiles := []string{
				linkPathOf(other),
				deviceKeyPathOf(other),
				filepath.Join(other.DirUnder(connectorRoot), "runtime.env"),
				filepath.Join(stateDirOf(other), linkRefusedMarker),
				filepath.Join(stateDirOf(other), linkAdmittedMarker),
				filepath.Join(stateDirOf(other), "link-context.json"),
				filepath.Join(stateDirOf(other), "link-token.json"),
			}
			for _, path := range otherFiles {
				writeUnlinkFixtureFile(t, path)
			}
			deps, calls := unlinkTestDeps(fixture, stage, false)
			err = unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps)
			if err == nil {
				t.Fatal("unlink succeeded without all lifecycle proofs")
			}
			if strings.Contains(err.Error(), "private callback failure detail") {
				t.Fatalf("callback detail escaped into the error: %q", err)
			}
			wantCalls := map[string][]string{
				"stop":     {"stop"},
				"inactive": {"stop", "inactive"},
				"disable":  {"stop", "inactive", "disable"},
			}[stage]
			if !reflect.DeepEqual(*calls, wantCalls) {
				t.Fatalf("lifecycle calls=%v, want %v", *calls, wantCalls)
			}
			assertUnlinkPathsPresent(t, append(append([]string{}, fixture.files...), fixture.deviceKey))
			assertUnlinkPathsPresent(t, otherFiles)
		})
	}
}

func TestUnlinkInstanceRemovesOnlyOneLinkAfterLifecycleProof(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", true)
	other, err := layout.ParseConnectorInstance("prod")
	if err != nil {
		t.Fatal(err)
	}
	otherFiles := []string{
		linkPathOf(other),
		deviceKeyPathOf(other),
		filepath.Join(other.DirUnder(connectorRoot), "runtime.env"),
		filepath.Join(stateDirOf(other), linkRefusedMarker),
		filepath.Join(stateDirOf(other), linkAdmittedMarker),
		filepath.Join(stateDirOf(other), "link-context.json"),
		filepath.Join(stateDirOf(other), "link-token.json"),
	}
	for _, path := range otherFiles {
		writeUnlinkFixtureFile(t, path)
	}
	hermesConfig := filepath.Join(fixture.base, "hermes-data", "config.yaml")
	writeUnlinkFixtureFile(t, hermesConfig)

	deps, calls := unlinkTestDeps(fixture, "", true)
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err != nil {
		t.Fatalf("unlink instance: %v", err)
	}
	if want := []string{"stop", "inactive", "disable"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("lifecycle calls=%v, want %v", *calls, want)
	}
	assertUnlinkPathsAbsent(t, fixture.files)
	assertUnlinkPathsPresent(t, append(append(otherFiles, fixture.deviceKey), hermesConfig))
}

func TestUnlinkInstanceRemovesDefaultLinkWithoutRemovingDeviceKey(t *testing.T) {
	fixture := newUnlinkFixture(t, "", false)
	deps, calls := unlinkTestDeps(fixture, "", true)
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err != nil {
		t.Fatalf("unlink default instance: %v", err)
	}
	if want := []string{"stop", "inactive", "disable"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("lifecycle calls=%v, want %v", *calls, want)
	}
	assertUnlinkPathsAbsent(t, fixture.files)
	assertUnlinkPathsPresent(t, []string{fixture.deviceKey})
}

func TestUnlinkInstanceIsIdempotentWhenLinkIsAbsent(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", false)
	if err := os.Remove(fixture.link); err != nil {
		t.Fatal(err)
	}
	deps, calls := unlinkTestDeps(fixture, "", false)
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err != nil {
		t.Fatalf("unlink with missing link: %v", err)
	}
	if want := []string{"stop", "inactive", "disable"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("lifecycle calls=%v, want %v", *calls, want)
	}
	assertUnlinkPathsAbsent(t, fixture.files)
	assertUnlinkPathsPresent(t, []string{fixture.deviceKey})
}

func TestUnlinkInstanceRejectsSymlinkBeforeStopping(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", false)
	if err := os.Remove(fixture.link); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(fixture.base, "outside-link")
	writeUnlinkFixtureFile(t, target)
	if err := os.Symlink(target, fixture.link); err != nil {
		t.Fatal(err)
	}
	deps, calls := unlinkTestDeps(fixture, "", false)
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err == nil {
		t.Fatal("symlink link credential accepted")
	}
	if len(*calls) != 0 {
		t.Fatalf("service lifecycle began before metadata validation: %v", *calls)
	}
	assertUnlinkPathsPresent(t, append(append([]string{}, fixture.files...), fixture.deviceKey, target))
}

func TestUnlinkInstanceRejectsInstanceDirectorySymlinkBeforeStopping(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", true)
	instanceDir := fixture.instance.DirUnder(connectorRoot)
	targetDir := filepath.Join(fixture.base, "moved-instance")
	if err := os.Rename(instanceDir, targetDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetDir, instanceDir); err != nil {
		t.Fatal(err)
	}
	deps, calls := unlinkTestDeps(fixture, "", false)
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err == nil {
		t.Fatal("symlinked connector instance directory accepted")
	}
	if len(*calls) != 0 {
		t.Fatalf("service lifecycle began before directory validation: %v", *calls)
	}
	info, err := os.Lstat(instanceDir)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("instance path no longer has the original symlink: info=%v err=%v", info, err)
	}
	assertUnlinkPathsPresent(t, append(append([]string{}, fixture.files...), fixture.deviceKey))
	assertUnlinkPathsPresent(t, []string{
		filepath.Join(targetDir, "link.json"),
		filepath.Join(targetDir, "runtime.env"),
		filepath.Join(targetDir, "device.key.cred"),
	})
	for _, path := range []string{
		filepath.Join(targetDir, "link.json"),
		filepath.Join(targetDir, "runtime.env"),
		filepath.Join(targetDir, "device.key.cred"),
	} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "test-only credential placeholder\n" {
			t.Errorf("symlink target content changed at %s: err=%v", path, err)
		}
	}
}

func TestUnlinkInstanceRejectsWrongStateOwnerBeforeStopping(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", true)
	deps, calls := unlinkTestDeps(fixture, "", false)
	deps.StateOwner = fsx.Owner{UID: fixture.owner.UID + 1, GID: fixture.owner.GID}
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err == nil {
		t.Fatal("state files owned by a different expected owner accepted")
	}
	if len(*calls) != 0 {
		t.Fatalf("service lifecycle began before state-owner validation: %v", *calls)
	}
	assertUnlinkPathsPresent(t, append(append([]string{}, fixture.files...), fixture.deviceKey))
}

func TestUnlinkInstanceRejectsMacShadowOutsideInstanceBeforeStopping(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", true)
	deps, calls := unlinkTestDeps(fixture, "", false)
	deps.RuntimeCredentialPath = filepath.Join(fixture.base, "other-instance", "runtime.env")
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err == nil {
		t.Fatal("runtime credential path outside the selected instance accepted")
	}
	if len(*calls) != 0 {
		t.Fatalf("service lifecycle began before credential-path validation: %v", *calls)
	}
	assertUnlinkPathsPresent(t, append(append([]string{}, fixture.files...), fixture.deviceKey))
}

func TestProveSystemdUnlinkStateRequiresKnownInactiveOrDisabledResult(t *testing.T) {
	cases := []struct {
		name    string
		verb    string
		result  exec.Result
		wantErr bool
	}{
		{name: "inactive", verb: "is-active", result: exec.Result{ExitCode: 3, Stdout: "inactive\n"}},
		{name: "failed", verb: "is-active", result: exec.Result{ExitCode: 3, Stdout: "failed\n"}},
		{name: "disabled", verb: "is-enabled", result: exec.Result{ExitCode: 1, Stdout: "disabled\n"}},
		{name: "masked", verb: "is-enabled", result: exec.Result{ExitCode: 1, Stdout: "masked\n"}},
		{name: "masked runtime", verb: "is-enabled", result: exec.Result{ExitCode: 1, Stdout: "masked-runtime\n"}},
		{name: "active", verb: "is-active", result: exec.Result{ExitCode: 0, Stdout: "active\n"}, wantErr: true},
		{name: "enabled", verb: "is-enabled", result: exec.Result{ExitCode: 0, Stdout: "enabled\n"}, wantErr: true},
		{name: "unknown state", verb: "is-active", result: exec.Result{ExitCode: 3, Stdout: "unknown\n"}, wantErr: true},
		{name: "unexpected exit", verb: "is-enabled", result: exec.Result{ExitCode: 3, Stdout: "disabled\n"}, wantErr: true},
		{name: "diagnostic output", verb: "is-active", result: exec.Result{ExitCode: 3, Stdout: "inactive\n", Stderr: "permission denied\n"}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const unit = "hermes-connector@dev"
			fake := exectest.NewFake().On("/usr/bin/systemctl "+tc.verb+" "+unit, tc.result)
			previousRunner := runner
			runner = fake
			t.Cleanup(func() { runner = previousRunner })

			err := proveSystemdUnlinkState(context.Background(), unit, tc.verb)
			if (err != nil) != tc.wantErr {
				t.Fatalf("proof error=%v, wantErr=%t", err, tc.wantErr)
			}
			want := "/usr/bin/systemctl " + tc.verb + " " + unit
			if got := fake.Commands(); !reflect.DeepEqual(got, []string{want}) {
				t.Fatalf("commands=%v, want [%s]", got, want)
			}
		})
	}
}

func TestProveSystemdUnlinkStateRejectsUnknownVerbWithoutCommand(t *testing.T) {
	fake := exectest.NewFake()
	previousRunner := runner
	runner = fake
	t.Cleanup(func() { runner = previousRunner })
	if err := proveSystemdUnlinkState(context.Background(), "hermes-connector@dev", "restart"); err == nil {
		t.Fatal("unsupported proof verb accepted")
	}
	if got := fake.Commands(); len(got) != 0 {
		t.Fatalf("unsupported proof verb ran commands: %v", got)
	}
}
