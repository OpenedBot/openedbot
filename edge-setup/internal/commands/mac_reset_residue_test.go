package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

type macResetUnregisteredService struct {
	*macResetRuntimeService
}

func (s *macResetUnregisteredService) Status(context.Context) (launchd.Status, error) {
	s.statusCalls++
	if s.statusCalls == 1 {
		s.tracker.preflightStatuses++
		s.tracker.events = append(s.tracker.events, "preflight:"+s.label)
	} else {
		s.tracker.events = append(s.tracker.events, "readback:"+s.label)
	}
	return launchd.Status{}, nil
}

func TestResetMacRuntimeDiscoversAndRemovesLogOnlyConnectorResidue(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{layout.DefaultConnectorInstance}, nil, nil, nil)
	inst := layout.ConnectorInstance("log-only")
	label, plist := macResetTestServicePaths(t, f.home, f.paths, launchd.Connector, inst)
	service := &macResetRuntimeService{label: label, plist: plist, tracker: f.tracker}
	f.tracker.services[label] = service
	logRoot := filepath.Join(f.home, "Library", "Logs", "OpenHermesBot")
	ownedLogs := []string{label + ".out.log", label + ".err.log"}
	for _, name := range ownedLogs {
		macResetTestWrite(t, filepath.Join(logRoot, name), "old connector log", 0o600)
	}
	unrelatedLog := filepath.Join(logRoot, "unrelated-service.out.log")
	macResetTestWrite(t, unrelatedLog, "preserve this log", 0o600)
	if len(f.registeredInitial) != 0 {
		t.Fatalf("log-only fixture unexpectedly has registered jobs: %v", f.registeredInitial)
	}
	for _, key := range f.keys.instances {
		if key == inst {
			t.Fatalf("log-only fixture unexpectedly has a device key for %q", inst)
		}
	}
	for _, path := range []string{plist, inst.DirUnder(f.paths.ConnectorRoot), inst.DirUnder(f.paths.StateRoot)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("log-only fixture unexpectedly has non-log state at %q, error=%v", path, err)
		}
	}

	deps := f.deps()
	deps.Service = func(kind launchd.Kind, requested layout.ConnectorInstance) (macResetService, error) {
		if kind == launchd.Connector && requested == inst {
			return &macResetUnregisteredService{macResetRuntimeService: service}, nil
		}
		return f.deps().Service(kind, requested)
	}
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, deps); err != nil {
		t.Fatalf("reset: %v", err)
	}
	for _, name := range ownedLogs {
		if _, err := os.Lstat(filepath.Join(logRoot, name)); !os.IsNotExist(err) {
			t.Errorf("owned residue log %q remains, error=%v", name, err)
		}
	}
	if data, err := os.ReadFile(unrelatedLog); err != nil || string(data) != "preserve this log" {
		t.Fatalf("unrelated log was not preserved: data=%q error=%v", data, err)
	}
	if service.statusCalls < 2 {
		t.Fatalf("log-only service had %d status checks, want stop proof", service.statusCalls)
	}
	stopped := false
	for _, event := range f.tracker.events {
		if event == "stop:"+label {
			stopped = true
			break
		}
	}
	if !stopped {
		t.Fatalf("log-only service %q was not included in the stop proof: %v", label, f.tracker.events)
	}
	for _, path := range []string{plist, inst.DirUnder(f.paths.ConnectorRoot), inst.DirUnder(f.paths.StateRoot)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Errorf("fixture unexpectedly had non-log state at %q, error=%v", path, err)
		}
	}
}

func TestResetMacRuntimeRejectsUnknownOwnedLogBeforeStopping(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, nil, nil, nil, nil)
	logRoot := filepath.Join(f.home, "Library", "Logs", "OpenHermesBot")
	unknown := filepath.Join(logRoot, macResetLabelPrefix+"connector.unknown.trace.log")
	macResetTestWrite(t, unknown, "unknown owned residue", 0o600)

	err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps())
	if err == nil {
		t.Fatal("reset accepted an unknown log in its namespace")
	}
	if f.tracker.stops != 0 {
		t.Fatalf("reset stopped %d services before rejecting the unknown log", f.tracker.stops)
	}
	if _, err := os.Lstat(unknown); err != nil {
		t.Fatalf("unknown log changed before rejection: %v", err)
	}
}

func TestResetMacRuntimeLockSurvivesPurgingApplicationRoot(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, nil, nil, nil, nil)
	lockPath := macSetupLockPath(f.paths)
	if filepath.Dir(lockPath) == f.paths.AppRoot || lockPath == filepath.Join(f.paths.AppRoot, "up.lock") {
		t.Fatalf("stable lock is inside the removable AppRoot: %q", lockPath)
	}
	unlock, err := lockMacRuntime(f.paths)
	if err != nil {
		t.Fatalf("create stable lock: %v", err)
	}
	initialInfo, err := os.Stat(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	unlock()

	var finalReadbackAttempted bool
	var finalReadbackBusy error
	var finalReadbackLockInfo os.FileInfo
	deps := f.deps()
	deps.Registered = func(context.Context) ([]layout.ConnectorInstance, error) {
		f.registeredCalls++
		f.tracker.events = append(f.tracker.events, "jobs:inventory")
		if f.registeredCalls == 1 {
			return nil, nil
		}
		if f.registeredCalls == 2 {
			finalReadbackAttempted = true
			if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
				return nil, errors.New("AppRoot still exists at final residue readback")
			}
			finalReadbackLockInfo, err = os.Stat(lockPath)
			if err != nil {
				return nil, err
			}
			attemptUnlock, attemptErr := lockMacRuntime(f.paths)
			finalReadbackBusy = attemptErr
			if attemptErr == nil {
				attemptUnlock()
			}
			return nil, nil
		}
		return nil, nil
	}

	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{PurgeData: true, DataLossAccepted: true}, deps); err != nil {
		t.Fatalf("purge reset: %v", err)
	}
	if !finalReadbackAttempted {
		t.Fatal("reset did not reach final registered-job readback")
	}
	if finalReadbackBusy == nil {
		t.Fatal("stable lock was available during final residue readback")
	}
	if !os.SameFile(initialInfo, finalReadbackLockInfo) {
		t.Fatal("stable lock inode changed while AppRoot was purged")
	}
	if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
		t.Fatalf("purge left or recreated AppRoot: %v", err)
	}

	unlock, err = lockMacRuntime(f.paths)
	if err != nil {
		t.Fatalf("stable lock could not be reacquired after reset: %v", err)
	}
	defer unlock()
	finalInfo, err := os.Stat(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(initialInfo, finalInfo) {
		t.Fatal("stable lock inode changed across reset")
	}
	if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
		t.Fatalf("reacquiring the stable lock recreated AppRoot: %v", err)
	}
}

func TestResetMacRuntimePlanDoesNotCreateStableLock(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, nil, nil, nil, nil)
	lockPath := macSetupLockPath(f.paths)
	// Preview also works for an older or incomplete setup without a lock.
	if err := os.Remove(lockPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("stable lock already exists before plan: %v", err)
	}
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{Plan: true}, f.deps()); err != nil {
		t.Fatalf("plan: %v", err)
	}
	if _, err := os.Lstat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("plan created the stable lock: %v", err)
	}
}
