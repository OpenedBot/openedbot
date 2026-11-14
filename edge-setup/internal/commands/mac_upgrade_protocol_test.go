package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
)

func macUpgradeFixtureRequest(t *testing.T, f *macUpgradeTestFixture) macUpgradeRequest {
	t.Helper()
	keys, err := collectMacUpgradeKeys(context.Background(), f.keys, f.inventory)
	if err != nil {
		t.Fatal(err)
	}
	return macUpgradeRequest{SHA256: f.candidate.sum, Version: "v2.0.0", Pin: f.paths.InstallDir, NodeBin: f.paths.NodeBin, Keys: keys,
		Jobs: []macUpgradeJob{{Kind: launchd.Connector, Instance: layout.DefaultConnectorInstance, PID: 701}}}
}

func TestMacUpgradeCheckDoesNotWriteOrRestart(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	request := macUpgradeFixtureRequest(t, f)
	if err := applyMacUpgradeImage(context.Background(), f.home, f.paths, request, "check", f.deps); err != nil {
		t.Fatal(err)
	}
	f.assertOldFiles(t, f.paths.Probe, f.paths.OAuthProbe, f.paths.ExecutablePath, f.paths.ToolConfig, f.active.plist)
	if f.active.stopCalls != 0 || f.active.startCalls != 0 {
		t.Fatal("check mutated a service")
	}
	if len(f.runner.calls) != 0 {
		t.Fatal("check spawned another image")
	}
}

func TestMacUpgradeApplyUsesOnlyProvedActiveJobs(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	request := macUpgradeFixtureRequest(t, f)
	if err := applyMacUpgradeImage(context.Background(), f.home, f.paths, request, "apply", f.deps); err != nil {
		t.Fatal(err)
	}
	if f.active.stopCalls != 1 || f.active.startCalls != 1 || f.active.startInstalled != 0 {
		t.Fatal("apply did not reload the active service")
	}
	if f.quiet.stopCalls != 0 || f.quiet.startCalls != 0 || f.quiet.startInstalled != 0 {
		t.Fatal("apply touched the refused waiting instance")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.quietPlist, f.refusedPath)
	data, err := os.ReadFile(f.paths.Probe)
	if err != nil || bytes.Equal(data, f.oldFiles[f.paths.Probe]) {
		t.Fatal("apply did not install the candidate probes")
	}
}

func TestMacUpgradeApplyRefusesIdentityAndJobDivergenceBeforeMutation(t *testing.T) {
	for _, name := range []string{"key", "inventory", "pid", "gateway", "duplicate", "pin"} {
		t.Run(name, func(t *testing.T) {
			f := newMacUpgradeTestFixture(t)
			request := macUpgradeFixtureRequest(t, f)
			switch name {
			case "key":
				request.Keys[0].Public = strings.Repeat("0", 64)
			case "inventory":
				f.inventory.instances = append(f.inventory.instances, "orphan")
			case "pid":
				request.Jobs[0].PID++
			case "gateway":
				request.Jobs[0].Kind = launchd.Gateway
			case "duplicate":
				request.Jobs = append(request.Jobs, request.Jobs[0])
			case "pin":
				request.Pin += "/other"
			}
			if err := applyMacUpgradeImage(context.Background(), f.home, f.paths, request, "apply", f.deps); err == nil {
				t.Fatal("divergent preflight was accepted")
			}
			if f.active.stopCalls != 0 || f.active.startCalls != 0 {
				t.Fatal("failed preflight mutated a job")
			}
			f.assertOldFiles(t, f.paths.Probe, f.paths.OAuthProbe, f.paths.ExecutablePath, f.paths.ToolConfig, f.active.plist)
		})
	}
}

func TestMacUpgradeHandoffRequiresExactPrivateRequestAndHeldLock(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	request := macUpgradeFixtureRequest(t, f)
	macResetTestMkdir(t, f.recoveryPath)
	data, _ := json.Marshal(request)
	macResetTestWrite(t, filepath.Join(f.recoveryPath, "request.json"), string(data), 0o600)
	unlock, err := lockMacRuntime(f.paths)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireMacUpgradeHandoff(f.paths, request); err != nil {
		unlock()
		t.Fatal(err)
	}
	changed := request
	changed.SHA256 = strings.Repeat("0", 64)
	if err := requireMacUpgradeHandoff(f.paths, changed); err == nil {
		unlock()
		t.Fatal("divergent handoff accepted")
	}
	unlock()
	if err := requireMacUpgradeHandoff(f.paths, request); err == nil {
		t.Fatal("inactive parent transaction accepted")
	}
}

type macUpgradeDirtyReader struct {
	buffer []byte
	err    error
}

func (r *macUpgradeDirtyReader) Read(context.Context, layout.ConnectorInstance) ([]byte, error) {
	return r.buffer, r.err
}

func TestMacUpgradeKeyInspectionWipesSeedAndRedactsFailures(t *testing.T) {
	for _, fail := range []bool{false, true} {
		r := &macUpgradeDirtyReader{buffer: bytes.Repeat([]byte{0x5a}, 32)}
		if fail {
			r.err = errors.New("private native error fixture")
		}
		keys, err := collectMacUpgradeKeys(context.Background(), r, &macUpgradeTestInventory{instances: []layout.ConnectorInstance{"orphan"}})
		if (err != nil) != fail {
			t.Fatalf("unexpected inspection result: %v", err)
		}
		if !bytes.Equal(r.buffer, make([]byte, 32)) {
			t.Fatal("read seed was not wiped")
		}
		if err != nil && strings.Contains(err.Error(), "private native error fixture") {
			t.Fatal("raw native error escaped")
		}
		if !fail && (len(keys) != 1 || len(keys[0].Public) != 64 || keys[0].Public == strings.Repeat("5a", 32)) {
			t.Fatal("inspection did not return a public identity")
		}
	}
}

func TestMacUpgradeInstalledResponseRequiresReadbackBeyondExitCode(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	request := macUpgradeFixtureRequest(t, f)
	for _, body := range []string{"", `{}`, `{"sha256":"wrong","version":"v2.0.0","stage":"check"}`, `{"sha256":"wrong","version":"v2.0.0","stage":"check","secret":"fixture"}`} {
		r := exectest.NewFake().On(f.paths.ExecutablePath+" internal mac-upgrade-check", exec.Result{Stdout: body})
		if err := callMacUpgradeImage(context.Background(), f.paths, request, "check", r); err == nil {
			t.Fatal("exit zero without exact response was accepted")
		}
	}
}

func TestMacUpgradeRefusesActiveJobWithoutRestorablePlist(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	if err := os.Remove(f.active.plist); err != nil {
		t.Fatal(err)
	}
	if err := f.run(t); err == nil {
		t.Fatal("active orphan job was upgraded without rollback definition")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig)
	if len(f.runner.calls) != 0 || f.active.stopCalls != 0 {
		t.Fatal("orphan refusal happened after mutation")
	}
}

func TestMacUpgradeAdmissionRequiresNewTimestampCorrectAgentAndPrivateMarker(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	job := macUpgradeFixtureRequest(t, f).Jobs[0]
	path := filepath.Join(f.paths.StateRoot, linkAdmittedMarker)
	since := time.Now().Add(-time.Second)
	for _, tc := range []struct {
		name, body string
		mode       os.FileMode
		good       bool
	}{
		{"current", "at=" + time.Now().UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v2.0.0\n", 0o600, true},
		{"legacy spelling", "at=" + time.Now().UTC().Format(time.RFC3339Nano) + "\nagent=hermes-setup/v2.0.0\n", 0o600, true},
		{"stale", "at=" + since.Add(-time.Second).UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v2.0.0\n", 0o600, false},
		{"wrong image", "at=" + time.Now().UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v1.0.0\n", 0o600, false},
		{"duplicate", "at=" + time.Now().UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v2.0.0\nagent=edge-setup/v2.0.0\n", 0o600, false},
		{"future", "at=" + time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v2.0.0\n", 0o600, false},
		{"public marker", "at=" + time.Now().UTC().Format(time.RFC3339Nano) + "\nagent=edge-setup/v2.0.0\n", 0o644, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			macResetTestWrite(t, path, tc.body, tc.mode)
			if got := macUpgradeAdmission(f.paths, job, "v2.0.0", since); got != tc.good {
				t.Fatalf("admission=%v, want %v", got, tc.good)
			}
		})
	}
}

func TestMacUpgradeMissingAdmissionRollsBackInsteadOfAcceptingRunningProcess(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	f.deps.Admission = func(_ context.Context, _ macUpgradeJob, version string, _ time.Time) error {
		if version == "v2.0.0" {
			return errors.New("new image was never admitted")
		}
		return nil
	}
	if err := f.run(t); err == nil {
		t.Fatal("process activity was accepted without a new link admission")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist)
	if f.active.startInstalled != 1 {
		t.Fatal("missing admission did not restore the old active connector")
	}
}

func TestMacUpgradeIdenticalCandidateKeepsExecutableInodeAndServices(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	before, err := os.Stat(f.paths.ExecutablePath)
	if err != nil {
		t.Fatal(err)
	}
	c := candidate{data: f.oldBinary, sum: selfupdate.Digest(f.oldBinary)}
	if err := upgradeMacRuntime(context.Background(), f.home, f.paths, c, "v1.0.0", f.deps); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(f.paths.ExecutablePath)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("identical upgrade replaced the executable inode")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist)
	if f.active.stopCalls != 0 || f.active.startCalls != 0 || len(f.runner.calls) != 1 {
		t.Fatal("identical upgrade mutated services or skipped the installed preflight")
	}
	if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
		t.Fatal("identical upgrade created recovery files")
	}
}
