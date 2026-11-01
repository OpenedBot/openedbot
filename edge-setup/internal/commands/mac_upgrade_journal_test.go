package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type macCrashService struct {
	Registered bool
	Running    bool
	PID        int
}

type macCrashFixture struct {
	Home     string
	OldFiles map[string][]byte
	Services map[string]macCrashService
}

func TestMacUpgradeCrashHelper(t *testing.T) {
	root, phase := os.Getenv("OHB_TEST_MAC_CRASH_ROOT"), os.Getenv("OHB_TEST_MAC_CRASH_PHASE")
	if root == "" || phase == "" {
		return
	}
	f := newMacUpgradeTestFixture(t)
	unlock, err := lockMacRuntime(f.paths)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	checkpoint := func(at string) {
		if at != phase {
			return
		}
		fixture := macCrashFixture{Home: f.home, OldFiles: f.oldFiles, Services: map[string]macCrashService{}}
		for key, service := range f.runner.services {
			fixture.Services[serviceKey(macUpgradeJob{Kind: key.kind, Instance: key.instance})] = macCrashService{
				Registered: service.registered, Running: service.running, PID: service.pid}
		}
		data, err := json.Marshal(fixture)
		if err != nil || fsx.WriteAtomic(filepath.Join(root, "ready.json"), data, 0o600, fsx.Current()) != nil {
			t.Fatal("checkpoint could not be persisted")
		}
		for {
			time.Sleep(time.Second)
		}
	}
	f.deps.Checkpoint = checkpoint
	f.runner.applyCheckpoint = checkpoint
	if err := f.run(t); err != nil {
		t.Fatal(err)
	}
	t.Fatal("requested crash checkpoint was not reached")
}

func restoreMacCrashFixture(t *testing.T, fixture macCrashFixture) *macUpgradeTestFixture {
	t.Helper()
	f := newMacUpgradeTestFixture(t)
	oldHome := f.home
	paths, err := layout.MacRuntime(fixture.Home)
	if err != nil {
		t.Fatal(err)
	}
	f.home, f.paths, f.runner.paths = fixture.Home, paths, paths
	f.oldFiles = fixture.OldFiles
	f.recoveryPath = filepath.Join(paths.AppRoot, "upgrade-recovery")
	f.refusedPath = strings.Replace(f.refusedPath, oldHome, fixture.Home, 1)
	f.quietPlist = strings.Replace(f.quietPlist, oldHome, fixture.Home, 1)
	for key, service := range f.runner.services {
		service.plist = strings.Replace(service.plist, oldHome, fixture.Home, 1)
		status, found := fixture.Services[serviceKey(macUpgradeJob{Kind: key.kind, Instance: key.instance})]
		if !found {
			t.Fatal("persisted fixture service is absent")
		}
		service.registered, service.running, service.pid = status.Registered, status.Running, status.PID
	}
	return f
}

func TestMacUpgradeSIGKILLRecovery(t *testing.T) {
	for _, phase := range []string{"preparing", "backup_written", "prepared", "installed", "applying", "apply_after_stop", "committed", "cleanup_partial"} {
		t.Run(phase, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0o700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := osexec.CommandContext(ctx, os.Args[0], "-test.run=^TestMacUpgradeCrashHelper$")
			cmd.Env = append(os.Environ(), "TMPDIR="+root, "OHB_TEST_MAC_CRASH_ROOT="+root, "OHB_TEST_MAC_CRASH_PHASE="+phase)
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill() }()
			ready := filepath.Join(root, "ready.json")
			for !fsx.Exists(ready) && ctx.Err() == nil {
				time.Sleep(10 * time.Millisecond)
			}
			if !fsx.Exists(ready) {
				_ = cmd.Wait()
				t.Fatalf("crash checkpoint was not reached: %s", output.String())
			}
			if err := cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			err := cmd.Wait()
			exit, ok := err.(*osexec.ExitError)
			if !ok {
				t.Fatal("helper was not killed")
			}
			status, ok := exit.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatal("helper did not terminate by SIGKILL")
			}
			data, err := fsx.ReadRegular(ready, 0o600, fsx.Current())
			if err != nil {
				t.Fatal(err)
			}
			var persisted macCrashFixture
			if err := json.Unmarshal(data, &persisted); err != nil {
				t.Fatal(err)
			}
			rel, err := filepath.Rel(root, persisted.Home)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				t.Fatal("helper home escaped its disposable directory")
			}
			f := restoreMacCrashFixture(t, persisted)
			unlock, err := lockMacRuntime(f.paths)
			if err != nil {
				t.Fatal("SIGKILL did not release the common setup lock")
			}
			defer unlock()
			// A later invocation may already be running the candidate image.
			f.deps.Version = "v2.0.0"
			admissions := 0
			f.deps.Admission = func(_ context.Context, _ macUpgradeJob, version string, _ time.Time) error {
				if version != "v1.0.0" {
					t.Fatal("recovery used the running candidate version for old admission")
				}
				admissions++
				return nil
			}
			recovered, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps)
			if err != nil || !recovered {
				t.Fatalf("recovery failed: %v", err)
			}
			terminal := phase == "committed" || phase == "cleanup_partial"
			if terminal {
				got, err := os.ReadFile(f.paths.ExecutablePath)
				if err != nil || !bytes.Equal(got, f.candidate.data) {
					t.Fatal("committed candidate was rolled back")
				}
				st, err := state.LoadFrom(f.paths.ToolConfig, fsx.Current())
				if err != nil || st == nil || st.ToolVersion != "v2.0.0" {
					t.Fatal("committed version was lost")
				}
			} else {
				for path := range f.oldFiles {
					f.assertOldFiles(t, path)
				}
			}
			restarted := phase == "applying" || phase == "apply_after_stop"
			if restarted && (f.active.startInstalled != 1 || admissions != 1 || !f.active.running) {
				t.Fatal("interrupted service activation was not restored and admitted")
			}
			if !restarted && (f.active.startInstalled != 0 || admissions != 0) {
				t.Fatal("recovery unnecessarily restarted a service")
			}
			if phase == "installed" || restarted {
				if len(f.runner.calls) == 0 || f.runner.calls[len(f.runner.calls)-1].request.Version != "v1.0.0" {
					t.Fatal("restored image was not checked against the journal's previous version")
				}
			}
			if f.quiet.startCalls != 0 || f.quiet.startInstalled != 0 {
				t.Fatal("inactive instance was restarted")
			}
			if fsx.Exists(f.recoveryPath) || fsx.Exists(macUpgradeJournalPath(f.paths)) {
				t.Fatal("proved recovery retained transaction files")
			}
			if again, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps); err != nil || again {
				t.Fatal("clean recovery was not idempotent")
			}
		})
	}
}

func stopMacUpgradeAt(t *testing.T, phase string) *macUpgradeTestFixture {
	t.Helper()
	f := newMacUpgradeTestFixture(t)
	f.deps.Checkpoint = func(at string) {
		if at == phase {
			panic("stop-test-upgrade")
		}
	}
	func() {
		defer func() {
			if recover() != "stop-test-upgrade" {
				t.Fatal("requested checkpoint did not stop upgrade")
			}
		}()
		_ = f.run(t)
	}()
	f.deps.Checkpoint = nil
	return f
}

func TestMacUpgradeRecoveryRefusesCorruptOrUnsafeMetadata(t *testing.T) {
	for _, mutation := range []string{"unknown_phase", "oversized_journal", "index_path", "backup_digest", "directory_symlink", "committed_digest"} {
		t.Run(mutation, func(t *testing.T) {
			f := stopMacUpgradeAt(t, "prepared")
			switch mutation {
			case "unknown_phase":
				data, _ := os.ReadFile(macUpgradeJournalPath(f.paths))
				var journal macUpgradeJournal
				if json.Unmarshal(data, &journal) != nil {
					t.Fatal("journal fixture unreadable")
				}
				journal.Phase = "unknown"
				if err := writeMacUpgradeJournal(f.paths, &journal); err != nil {
					t.Fatal(err)
				}
			case "oversized_journal":
				if err := os.WriteFile(macUpgradeJournalPath(f.paths), bytes.Repeat([]byte{'x'}, macUpgradeJournalLimit+1), 0o600); err != nil {
					t.Fatal(err)
				}
			case "index_path", "backup_digest":
				data, _ := os.ReadFile(macUpgradeJournalPath(f.paths))
				var journal macUpgradeJournal
				if json.Unmarshal(data, &journal) != nil {
					t.Fatal("journal fixture unreadable")
				}
				journal.Phase = "installing"
				if err := writeMacUpgradeJournal(f.paths, &journal); err != nil {
					t.Fatal(err)
				}
				if mutation == "index_path" {
					indexPath := filepath.Join(f.recoveryPath, "index.json")
					data, _ := os.ReadFile(indexPath)
					var index []macUpgradeSnapshot
					if json.Unmarshal(data, &index) != nil {
						t.Fatal("index fixture unreadable")
					}
					index[0].Path = filepath.Join(f.home, "outside-managed-binary")
					if os.WriteFile(index[0].Path, []byte("preserve-unmanaged"), 0o600) != nil {
						t.Fatal("sentinel fixture write failed")
					}
					data, _ = json.Marshal(index)
					if os.WriteFile(indexPath, data, 0o600) != nil {
						t.Fatal("index fixture write failed")
					}
				} else if os.WriteFile(filepath.Join(f.recoveryPath, "000"), []byte("corrupt backup"), 0o700) != nil {
					t.Fatal("backup fixture write failed")
				}
			case "directory_symlink":
				if err := os.Rename(f.recoveryPath, f.recoveryPath+"-saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(f.recoveryPath+"-saved", f.recoveryPath); err != nil {
					t.Fatal(err)
				}
			case "committed_digest":
				data, _ := os.ReadFile(macUpgradeJournalPath(f.paths))
				var journal macUpgradeJournal
				if json.Unmarshal(data, &journal) != nil {
					t.Fatal("journal fixture unreadable")
				}
				journal.Phase, journal.Terminal = "committed", journal.Snapshots
				if err := writeMacUpgradeJournal(f.paths, &journal); err != nil {
					t.Fatal(err)
				}
			}
			calls := len(f.runner.calls)
			if recovered, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps); err == nil || recovered {
				t.Fatal("unsafe recovery was accepted")
			}
			for path := range f.oldFiles {
				f.assertOldFiles(t, path)
			}
			if len(f.runner.calls) != calls || f.active.stopCalls != 0 {
				t.Fatal("unsafe metadata caused execution or restart")
			}
			if !fsx.Exists(macUpgradeJournalPath(f.paths)) {
				t.Fatal("unsafe journal was discarded")
			}
			if mutation == "index_path" {
				data, err := os.ReadFile(filepath.Join(f.home, "outside-managed-binary"))
				if err != nil || string(data) != "preserve-unmanaged" {
					t.Fatal("unmanaged sentinel was overwritten")
				}
			}
		})
	}
}

func TestMacUpgradeRecoveryRetriesAnUnprovedRollback(t *testing.T) {
	f := stopMacUpgradeAt(t, "applying")
	f.runner.failRollbackOldCheck = true
	if recovered, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps); err == nil || recovered {
		t.Fatal("unproved rollback was accepted")
	}
	if !fsx.Exists(f.recoveryPath) || !fsx.Exists(macUpgradeJournalPath(f.paths)) {
		t.Fatal("failed rollback discarded its recovery evidence")
	}
	f.runner.failRollbackOldCheck = false
	if recovered, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps); err != nil || !recovered {
		t.Fatalf("rollback retry did not recover: %v", err)
	}
	for path := range f.oldFiles {
		f.assertOldFiles(t, path)
	}
	if f.active.startInstalled != 2 {
		t.Fatal("rollback retry did not re-prove the previously active job")
	}
}

func TestMacUpgradeRecoveryPreservesLegacyDirectory(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	if err := os.Mkdir(f.recoveryPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if recovered, err := recoverMacUpgrade(context.Background(), f.home, f.paths, f.deps); err == nil || recovered {
		t.Fatal("legacy recovery was guessed")
	}
	if !fsx.Exists(f.recoveryPath) {
		t.Fatal("legacy recovery was removed")
	}
}

func TestMacUpgradeRecoveryRequiresTheRecordedConnectorKey(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	request := macUpgradeRequest{SHA256: f.candidate.sum, Version: "v2.0.0", Pin: f.paths.InstallDir, NodeBin: f.paths.NodeBin,
		Jobs: []macUpgradeJob{{Kind: launchd.Connector, Instance: layout.DefaultConnectorInstance, PID: 701}}}
	if _, err := macUpgradeTargets(f.home, f.paths, request, f.deps); err == nil {
		t.Fatal("connector recovery target without its public identity was accepted")
	}
}
