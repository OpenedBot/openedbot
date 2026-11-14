package apt

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

type missingRunner struct {
	calls     []exec.Cmd
	installed map[string]bool
	held      map[string]bool
	policy    string
	fail      string
	omit      bool
}

func (r *missingRunner) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	r.calls = append(r.calls, c)
	if err := ctx.Err(); err != nil {
		return exec.Result{}, err
	}
	if c.Path == dpkgQuery {
		pkg := c.Args[len(c.Args)-1]
		if r.fail == "dpkg" {
			return exec.Result{}, errors.New("missing dpkg-query")
		}
		if r.fail == "status" {
			return exec.Result{Stdout: "garbage"}, nil
		}
		if r.installed[pkg] {
			if r.held[pkg] {
				return exec.Result{Stdout: "hold ok installed\n"}, nil
			}
			return exec.Result{Stdout: "install ok installed\n"}, nil
		}
		return exec.Result{ExitCode: 1}, nil
	}
	if c.Path != aptGet {
		return exec.Result{}, errors.New("unexpected command")
	}
	if c.Args[0] == "update" {
		if r.fail == "update" {
			return exec.Result{ExitCode: 100}, nil
		}
		return exec.Result{}, nil
	}
	if c.Args[0] != "install" {
		return exec.Result{}, errors.New("unexpected APT mutation")
	}
	if _, err := os.Stat(r.policy); err != nil {
		return exec.Result{}, errors.New("service-start policy missing")
	}
	if r.fail == "install" {
		return exec.Result{ExitCode: 100}, nil
	}
	if !r.omit {
		for _, pkg := range c.Args[5:] {
			r.installed[pkg] = true
		}
	}
	return exec.Result{}, nil
}
func missingFixture(t *testing.T) (Client, *missingRunner) {
	t.Helper()
	runner := &missingRunner{installed: map[string]bool{}, held: map[string]bool{}, policy: filepath.Join(t.TempDir(), "policy-rc.d")}
	return Client{Runner: runner, PolicyRcD: runner.policy}, runner
}
func TestInstallMissingTargetsOnlyAbsentPackagesAndIsIdempotent(t *testing.T) {
	client, runner := missingFixture(t)
	runner.installed["libnss3"] = true
	if err := client.InstallMissing(context.Background(), "libnss3", "libnspr4"); err != nil {
		t.Fatal(err)
	}
	var installs []string
	for _, c := range runner.calls {
		if c.Path == aptGet && c.Args[0] == "install" {
			installs = append(installs, c.String())
		}
	}
	if len(installs) != 1 || installs[0] != "/usr/bin/apt-get install -y --no-install-recommends --no-upgrade --no-remove libnspr4" {
		t.Fatalf("install scope: %v", installs)
	}
	if _, err := os.Stat(runner.policy); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary policy retained")
	}
	runner.calls = nil
	if err := client.InstallMissing(context.Background(), "libnss3", "libnspr4"); err != nil {
		t.Fatal(err)
	}
	for _, c := range runner.calls {
		if c.Path == aptGet {
			t.Fatal("idempotent dependency check invoked APT")
		}
	}
}
func TestInstallMissingFailsClosedWithActionableErrors(t *testing.T) {
	for _, failure := range []string{"dpkg", "status", "update", "install", "verification"} {
		t.Run(failure, func(t *testing.T) {
			client, runner := missingFixture(t)
			runner.fail = failure
			runner.omit = failure == "verification"
			if err := client.InstallMissing(context.Background(), "libnspr4"); err == nil {
				t.Fatal("dependency failure accepted")
			}
			if _, err := os.Stat(runner.policy); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("temporary policy retained after failure")
			}
			for _, c := range runner.calls {
				if c.Path == aptGet && (c.Args[0] == "upgrade" || c.Args[0] == "purge" || c.Args[0] == "remove") {
					t.Fatal("broad mutation")
				}
			}
		})
	}
}
func TestInstallMissingRejectsFlagInjectionBeforeCommands(t *testing.T) {
	client, runner := missingFixture(t)
	if err := client.InstallMissing(context.Background(), "--allow-unauthenticated"); err == nil {
		t.Fatal("flag accepted")
	}
	if len(runner.calls) != 0 {
		t.Fatal("command before argument validation")
	}
}
func TestInstallMissingHonorsCancellation(t *testing.T) {
	client, _ := missingFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := client.InstallMissing(ctx, "libnss3"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
func TestInstallMissingPreservesExistingPolicy(t *testing.T) {
	client, runner := missingFixture(t)
	if err := os.WriteFile(runner.policy, []byte("operator policy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := client.InstallMissing(context.Background(), "libnspr4"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(runner.policy)
	if err != nil || !strings.Contains(string(data), "operator policy") {
		t.Fatal("operator policy overwritten")
	}
}

func TestInstallMissingPreservesHealthyHeldPackages(t *testing.T) {
	client, runner := missingFixture(t)
	runner.installed["libnss3"] = true
	runner.held["libnss3"] = true
	if err := client.InstallMissing(context.Background(), "libnss3"); err != nil {
		t.Fatal(err)
	}
	for _, command := range runner.calls {
		if command.Path != dpkgQuery {
			t.Fatalf("held package triggered mutation: %s", command.String())
		}
	}
	runner.calls = nil
	if err := client.InstallMissing(context.Background(), "libnss3", "libnspr4"); err != nil {
		t.Fatal(err)
	}
	heldReads := 0
	for _, command := range runner.calls {
		if command.Path == dpkgQuery && command.Args[len(command.Args)-1] == "libnss3" {
			heldReads++
		}
		if command.Path == aptGet && command.Args[0] == "install" && strings.Contains(command.String(), "libnss3") {
			t.Fatal("held package passed to APT")
		}
	}
	if heldReads != 2 || !runner.held["libnss3"] {
		t.Fatal("held package was not preserved and verified after installing another dependency")
	}
}
func TestFullyInstalledValidatesAllDpkgStatusFields(t *testing.T) {
	for _, sample := range []struct {
		status           string
		healthy, invalid bool
	}{
		{"install ok installed", true, false}, {"hold ok installed", true, false},
		{"hold reinstreq installed", false, false}, {"hold ok unpacked", false, false},
		{"deinstall ok installed", false, false}, {"purge ok config-files", false, false},
		{"install ok imaginary", false, true}, {"malicious ok installed", false, true},
		{"hold broken installed", false, true}, {"hold ok installed extra", false, true},
	} {
		t.Run(sample.status, func(t *testing.T) {
			fake := exectest.NewFake()
			fake.OnPrefix(dpkgQuery, exec.Result{Stdout: sample.status + "\n"})
			healthy, err := (Client{Runner: fake}).fullyInstalled(context.Background(), "libnss3")
			if healthy != sample.healthy || (err != nil) != sample.invalid {
				t.Fatalf("status=%q healthy=%v err=%v", sample.status, healthy, err)
			}
		})
	}
}
