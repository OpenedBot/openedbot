package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type macUpgradeTestKeys struct {
	seed []byte
	err  error
	read int
}

func (k *macUpgradeTestKeys) Read(_ context.Context, instance layout.ConnectorInstance) ([]byte, error) {
	k.read++
	if k.err != nil {
		return nil, k.err
	}
	if instance != layout.DefaultConnectorInstance {
		return nil, errors.New("fixture key is absent")
	}
	return append([]byte(nil), k.seed...), nil
}

var _ macUpgradeKeyReader = (*macUpgradeTestKeys)(nil)

type macUpgradeTestInventory struct {
	instances []layout.ConnectorInstance
	err       error
}

func (i *macUpgradeTestInventory) Instances(context.Context) ([]layout.ConnectorInstance, error) {
	if i.err != nil {
		return nil, i.err
	}
	return append([]layout.ConnectorInstance(nil), i.instances...), nil
}

var _ devicekeys.Inventory = (*macUpgradeTestInventory)(nil)

type macUpgradeTestServiceKey struct {
	kind     launchd.Kind
	instance layout.ConnectorInstance
}

type macUpgradeTestService struct {
	label, plist     string
	registered       bool
	running          bool
	pid              int
	statusState      string
	forceStatusState bool
	stopCalls        int
	startCalls       int
	startInstalled   int
	startPlistCopies [][]byte
}

func (s *macUpgradeTestService) Stop(context.Context) error {
	s.stopCalls++
	s.registered, s.running, s.pid = false, false, 0
	return nil
}

func (s *macUpgradeTestService) Status(context.Context) (launchd.Status, error) {
	state := s.statusState
	if !s.forceStatusState {
		switch {
		case s.running:
			state = "running"
		case s.registered:
			state = "waiting"
		default:
			state = "not running"
		}
	}
	return launchd.Status{Registered: s.registered, Running: s.running, State: state, PID: s.pid}, nil
}

func (s *macUpgradeTestService) PlistPath() string { return s.plist }
func (s *macUpgradeTestService) Label() string     { return s.label }

func (s *macUpgradeTestService) Start(context.Context) error {
	s.startCalls++
	s.registered, s.running = true, true
	s.pid = 1200 + s.startCalls
	return nil
}

func (s *macUpgradeTestService) StartInstalled(context.Context) error {
	s.startInstalled++
	data, err := os.ReadFile(s.plist)
	if err != nil {
		return err
	}
	s.startPlistCopies = append(s.startPlistCopies, append([]byte(nil), data...))
	s.registered, s.running = true, true
	s.pid = 1300 + s.startInstalled
	return nil
}

func (s *macUpgradeTestService) RenderPlist() ([]byte, error) {
	return []byte("rendered plist fixture"), nil
}

var _ macUpgradeService = (*macUpgradeTestService)(nil)

type macUpgradeTestCall struct {
	stage   string
	request macUpgradeRequest
}

type macUpgradeTestRunner struct {
	paths                 layout.MacRuntimePaths
	services              map[macUpgradeTestServiceKey]*macUpgradeTestService
	calls                 []macUpgradeTestCall
	failCandidateCheck    bool
	failCandidateApply    bool
	failRollbackOldCheck  bool
	oldCheckCount         int
	postReplacementChecks int
	applyCheckpoint       func(string)
}

func (r *macUpgradeTestRunner) Run(_ context.Context, cmd exec.Cmd) (exec.Result, error) {
	if cmd.Path != r.paths.ExecutablePath || len(cmd.Args) != 2 || cmd.Args[0] != "internal" {
		return exec.Result{}, errors.New("unexpected fixture command")
	}
	stage := ""
	switch cmd.Args[1] {
	case "mac-upgrade-check":
		stage = "check"
	case "mac-upgrade-apply":
		stage = "apply"
	default:
		return exec.Result{}, errors.New("unexpected fixture stage")
	}
	var request macUpgradeRequest
	if err := decodeMacUpgradeJSON(cmd.Stdin, &request); err != nil {
		return exec.Result{}, err
	}
	if request.SHA256 == "" || request.Version == "" || request.Pin != r.paths.InstallDir || request.NodeBin != r.paths.NodeBin {
		return exec.Result{}, errors.New("fixture received an incomplete upgrade request")
	}
	r.calls = append(r.calls, macUpgradeTestCall{stage: stage, request: request})
	installed, err := os.ReadFile(r.paths.ExecutablePath)
	if err != nil {
		return exec.Result{}, err
	}
	if selfupdate.Digest(installed) != request.SHA256 {
		return exec.Result{}, errors.New("fixture request digest did not match the executable on disk")
	}
	if request.Version == "v2.0.0" && stage == "check" {
		r.postReplacementChecks++
	}
	if request.Version == "v1.0.0" && stage == "check" {
		r.oldCheckCount++
	}

	fail := false
	if stage == "check" && request.Version == "v2.0.0" && r.failCandidateCheck {
		fail = true
	}
	if stage == "check" && request.Version == "v1.0.0" && r.failRollbackOldCheck && r.oldCheckCount > 1 {
		fail = true
	}
	if stage == "apply" && request.Version == "v2.0.0" {
		if err := r.mutateChildApply(request); err != nil {
			return exec.Result{}, err
		}
		if r.failCandidateApply {
			fail = true
		}
	}
	response, err := json.Marshal(macUpgradeResponse{SHA256: request.SHA256, Version: request.Version, Stage: stage})
	if err != nil {
		return exec.Result{}, err
	}
	code := 0
	if fail {
		code = 1
	}
	return exec.Result{Stdout: string(response), ExitCode: code}, nil
}

func (r *macUpgradeTestRunner) mutateChildApply(request macUpgradeRequest) error {
	for _, path := range []string{r.paths.Probe, r.paths.OAuthProbe} {
		if err := os.WriteFile(path, []byte("candidate probe contents"), 0o600); err != nil {
			return err
		}
	}
	for _, job := range request.Jobs {
		service := r.services[macUpgradeTestServiceKey{kind: job.Kind, instance: job.Instance}]
		if service == nil {
			return errors.New("fixture child job had no service")
		}
		if err := os.WriteFile(service.PlistPath(), []byte("candidate plist contents"), 0o600); err != nil {
			return err
		}
		if r.applyCheckpoint != nil {
			service.registered, service.running, service.pid = false, false, 0
			r.applyCheckpoint("apply_after_stop")
		}
		if r.failCandidateApply {
			service.registered, service.running, service.pid = false, false, 0
		} else {
			service.registered, service.running, service.pid = true, true, 2100
		}
	}
	if r.failCandidateApply {
		if err := os.WriteFile(r.paths.ToolConfig, []byte("partial child state"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

type macUpgradeTestFixture struct {
	home         string
	paths        layout.MacRuntimePaths
	oldBinary    []byte
	candidate    candidate
	oldFiles     map[string][]byte
	quiet        *macUpgradeTestService
	active       *macUpgradeTestService
	keys         *macUpgradeTestKeys
	inventory    *macUpgradeTestInventory
	runner       *macUpgradeTestRunner
	deps         macUpgradeDeps
	refusedPath  string
	quietPlist   string
	recoveryPath string
}

func newMacUpgradeTestFixture(t *testing.T) *macUpgradeTestFixture {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	logRoot := filepath.Join(home, "Library", "Logs", "app.openedbot.edge-setup")
	for _, dir := range []string{paths.AppRoot, paths.RuntimeRoot, paths.ConnectorRoot, paths.StateRoot,
		filepath.Dir(paths.ExecutablePath), filepath.Join(home, "Library", "LaunchAgents"), logRoot} {
		macResetTestMkdir(t, dir)
	}

	oldBinary := []byte("old edge-setup binary fixture")
	candidateData := []byte("candidate edge-setup binary fixture")
	macResetTestWrite(t, paths.ExecutablePath, string(oldBinary), 0o700)
	macResetTestWrite(t, paths.Probe, "old operator probe", 0o600)
	macResetTestWrite(t, paths.OAuthProbe, "old OAuth probe", 0o600)

	toolState := state.New("v1.0.0")
	toolState.Mode = state.ModeConnector
	toolState.Features.Sandbox = true
	toolState.PinsApplied["fixture"] = "preserve-on-rollback"
	if err := toolState.SaveTo(paths.ToolConfig, fsx.Current()); err != nil {
		t.Fatal(err)
	}

	activeKind := launchd.Connector
	activeInstance := layout.DefaultConnectorInstance
	activeLabel, activePlist := macResetTestServicePaths(t, home, paths, activeKind, activeInstance)
	quietInstance := layout.ConnectorInstance("quiet")
	quietLabel, quietPlist := macResetTestServicePaths(t, home, paths, launchd.Connector, quietInstance)
	operatorLabel, operatorPlist := macResetTestServicePaths(t, home, paths, launchd.Operator, layout.DefaultConnectorInstance)
	macResetTestWrite(t, activePlist, "old active connector plist", 0o600)
	macResetTestWrite(t, quietPlist, "quiet connector plist", 0o600)
	macResetTestWrite(t, operatorPlist, "inactive operator plist", 0o600)
	macResetTestWrite(t, filepath.Join(activeInstance.DirUnder(paths.ConnectorRoot), "link.json"), "active link fixture", 0o600)
	refusedPath := filepath.Join(quietInstance.DirUnder(paths.StateRoot), linkRefusedMarker)
	macResetTestWrite(t, refusedPath, "reason=fixture-refused\n", 0o600)

	active := &macUpgradeTestService{label: activeLabel, plist: activePlist, registered: true, running: true, pid: 701}
	quiet := &macUpgradeTestService{label: quietLabel, plist: quietPlist, registered: true}
	operatorService := &macUpgradeTestService{label: operatorLabel, plist: operatorPlist}
	services := map[macUpgradeTestServiceKey]*macUpgradeTestService{
		{kind: launchd.Connector, instance: layout.DefaultConnectorInstance}: active,
		{kind: launchd.Connector, instance: quietInstance}:                   quiet,
		{kind: launchd.Operator, instance: layout.DefaultConnectorInstance}:  operatorService,
	}
	keys := &macUpgradeTestKeys{seed: bytes.Repeat([]byte{0x2a}, 32)}
	inventory := &macUpgradeTestInventory{instances: []layout.ConnectorInstance{layout.DefaultConnectorInstance}}
	runner := &macUpgradeTestRunner{paths: paths, services: services}
	registered := []layout.ConnectorInstance{layout.DefaultConnectorInstance, quietInstance}
	f := &macUpgradeTestFixture{home: home, paths: paths, oldBinary: oldBinary,
		candidate: candidate{data: candidateData, sum: selfupdate.Digest(candidateData)},
		active:    active, quiet: quiet, keys: keys, inventory: inventory, runner: runner,
		refusedPath: refusedPath, quietPlist: quietPlist, recoveryPath: filepath.Join(paths.AppRoot, "upgrade-recovery")}
	f.deps = macUpgradeDeps{
		Keys:      keys,
		Inventory: inventory,
		Registered: func(context.Context) ([]layout.ConnectorInstance, error) {
			return append([]layout.ConnectorInstance(nil), registered...), nil
		},
		Service: func(kind launchd.Kind, instance layout.ConnectorInstance) (macUpgradeService, error) {
			service := services[macUpgradeTestServiceKey{kind: kind, instance: instance}]
			if service == nil {
				return nil, errors.New("unexpected fixture service selector")
			}
			return service, nil
		},
		Runner: runner,
		Operator: func(context.Context) error {
			return nil
		},
		Admission: func(context.Context, macUpgradeJob, string, time.Time) error { return nil },
		Version:   "v1.0.0",
	}
	f.oldFiles = map[string][]byte{}
	for _, path := range []string{paths.ExecutablePath, paths.ToolConfig, paths.Probe, paths.OAuthProbe, activePlist, quietPlist, refusedPath} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		f.oldFiles[path] = data
	}
	return f
}

func (f *macUpgradeTestFixture) run(t *testing.T) error {
	t.Helper()
	return upgradeMacRuntime(context.Background(), f.home, f.paths, f.candidate, "v2.0.0", f.deps)
}

func (f *macUpgradeTestFixture) assertOldFiles(t *testing.T, names ...string) {
	t.Helper()
	for _, path := range names {
		want, ok := f.oldFiles[path]
		if !ok {
			t.Fatalf("fixture has no saved bytes for %q", path)
		}
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("file %q was not restored exactly: error=%v", path, err)
		}
	}
}

func TestUpgradeMacRuntimeRefusesInaccessibleIdentityBeforeWriting(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	f.keys.err = errors.New("inaccessible fixture key")
	if err := f.run(t); err == nil {
		t.Fatal("upgrade succeeded without reading the existing identity")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe)
	if len(f.runner.calls) != 0 {
		t.Fatalf("child image was called before identity access was proved: %+v", f.runner.calls)
	}
	if f.active.stopCalls != 0 || f.active.startCalls != 0 || f.active.startInstalled != 0 {
		t.Fatal("inaccessible identity reached a service mutation")
	}
	if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("identity preflight created a recovery directory: %v", err)
	}
}

func TestUpgradeMacRuntimeRefusesAmbiguousServiceStatusBeforeReplacement(t *testing.T) {
	for _, tc := range []struct {
		name    string
		running bool
		state   string
		pid     int
	}{
		{name: "running state without running process", state: "running"},
		{name: "unknown inactive state", state: ""},
		{name: "running process without pid", running: true, state: "running"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacUpgradeTestFixture(t)
			f.active.running = tc.running
			f.active.statusState = tc.state
			f.active.forceStatusState = true
			f.active.pid = tc.pid
			if err := f.run(t); err == nil {
				t.Fatal("upgrade accepted an ambiguous LaunchAgent state")
			}
			f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist)
			if len(f.runner.calls) != 0 || f.active.stopCalls != 0 || f.active.startCalls != 0 || f.active.startInstalled != 0 {
				t.Fatal("ambiguous service state reached candidate execution or service mutation")
			}
			if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
				t.Fatalf("ambiguous status created a recovery directory: %v", err)
			}
		})
	}
}

func TestUpgradeMacRuntimeRestoresBinaryWhenCandidateCheckFails(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	f.runner.failCandidateCheck = true
	err := f.run(t)
	if err == nil {
		t.Fatal("upgrade accepted a failing candidate check")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist)
	if f.runner.postReplacementChecks != 1 {
		t.Fatalf("candidate check calls=%d, want one after replacement", f.runner.postReplacementChecks)
	}
	if f.active.stopCalls != 0 || f.active.startCalls != 0 || f.active.startInstalled != 0 {
		t.Fatalf("candidate check failure mutated the service: stop=%d start=%d start-installed=%d", f.active.stopCalls, f.active.startCalls, f.active.startInstalled)
	}
	assertMacUpgradeCallSequence(t, f, []macUpgradeExpectedCall{{stage: "check", version: "v1.0.0"}, {stage: "check", version: "v2.0.0"}, {stage: "check", version: "v1.0.0"}})
	if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("proved binary rollback retained the recovery directory: %v", err)
	}
}

func TestUpgradeMacRuntimeApplyFailureRestoresSnapshotAndInstalledServices(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	f.runner.failCandidateApply = true
	if err := f.run(t); err == nil {
		t.Fatal("upgrade accepted a failing candidate apply")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist, f.quietPlist, f.refusedPath)
	if f.active.startInstalled != 1 || f.active.startCalls != 0 || f.active.stopCalls != 1 {
		t.Fatalf("rollback did not restart the active service from its installed plist: stop=%d start=%d start-installed=%d", f.active.stopCalls, f.active.startCalls, f.active.startInstalled)
	}
	if len(f.active.startPlistCopies) != 1 || !bytes.Equal(f.active.startPlistCopies[0], f.oldFiles[f.active.plist]) {
		t.Fatal("StartInstalled did not use the exact restored plist")
	}
	if f.quiet.stopCalls != 0 || f.quiet.startCalls != 0 || f.quiet.startInstalled != 0 || !f.quiet.registered || f.quiet.running {
		t.Fatal("inactive refused instance was changed during the failed upgrade")
	}
	assertMacUpgradeCallSequence(t, f, []macUpgradeExpectedCall{{stage: "check", version: "v1.0.0"}, {stage: "check", version: "v2.0.0"}, {stage: "apply", version: "v2.0.0"}, {stage: "check", version: "v1.0.0"}})
	if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("proved rollback retained its recovery copy: %v", err)
	}
}

func TestUpgradeMacRuntimeRetainsRecoveryCopyWhenRollbackProofFails(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	f.runner.failCandidateApply = true
	f.runner.failRollbackOldCheck = true
	if err := f.run(t); err == nil {
		t.Fatal("upgrade hid a failed rollback proof")
	}
	f.assertOldFiles(t, f.paths.ExecutablePath, f.paths.ToolConfig, f.paths.Probe, f.paths.OAuthProbe, f.active.plist)
	if info, err := os.Stat(f.recoveryPath); err != nil || !info.IsDir() {
		t.Fatalf("recovery copy was not retained after failed rollback proof: info=%v error=%v", info, err)
	}
	backup, err := os.ReadFile(filepath.Join(f.recoveryPath, "000"))
	if err != nil || !bytes.Equal(backup, f.oldFiles[f.paths.ExecutablePath]) {
		t.Fatalf("recovery copy does not contain the original binary: error=%v", err)
	}
	if f.active.startInstalled != 1 || f.active.startCalls != 0 {
		t.Fatalf("rollback used an uninstalled plist start: start=%d start-installed=%d", f.active.startCalls, f.active.startInstalled)
	}
}

func TestUpgradeMacRuntimeSuccessReadsVersionAndCleansRecovery(t *testing.T) {
	f := newMacUpgradeTestFixture(t)
	if err := f.run(t); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	installed, err := os.ReadFile(f.paths.ExecutablePath)
	if err != nil || !bytes.Equal(installed, f.candidate.data) {
		t.Fatalf("candidate executable was not installed: error=%v", err)
	}
	info, err := os.Stat(f.paths.ExecutablePath)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("candidate executable mode is not 0700: info=%v error=%v", info, err)
	}
	proof, err := state.LoadFrom(f.paths.ToolConfig, fsx.Current())
	if err != nil || proof == nil || proof.ToolVersion != "v2.0.0" {
		t.Fatalf("upgraded tool version did not read back: state=%+v error=%v", proof, err)
	}
	for _, path := range []string{f.paths.Probe, f.paths.OAuthProbe} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "candidate probe contents" {
			t.Errorf("candidate probe %q did not read back: data=%q error=%v", path, data, err)
		}
	}
	if _, err := os.Lstat(f.recoveryPath); !os.IsNotExist(err) {
		t.Fatalf("successful upgrade retained its recovery directory: %v", err)
	}
	if f.quiet.stopCalls != 0 || f.quiet.startCalls != 0 || f.quiet.startInstalled != 0 || !f.quiet.registered || f.quiet.running {
		t.Fatal("successful upgrade changed the inactive refused instance")
	}
	assertMacUpgradeCallSequence(t, f, []macUpgradeExpectedCall{{stage: "check", version: "v1.0.0"}, {stage: "check", version: "v2.0.0"}, {stage: "apply", version: "v2.0.0"}})
}

type macUpgradeExpectedCall struct {
	stage, version string
}

func assertMacUpgradeCallSequence(t *testing.T, f *macUpgradeTestFixture, want []macUpgradeExpectedCall) {
	t.Helper()
	got := f.runner.calls
	if len(got) != len(want) {
		t.Fatalf("child call count=%d, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].stage != want[i].stage || got[i].request.Version != want[i].version {
			t.Fatalf("child call %d = %s/%s, want %s/%s", i, got[i].stage, got[i].request.Version, want[i].stage, want[i].version)
		}
		wantDigest := f.candidate.sum
		if want[i].version == "v1.0.0" {
			wantDigest = selfupdate.Digest(f.oldBinary)
		}
		if got[i].request.SHA256 != wantDigest || got[i].request.Pin != f.paths.InstallDir || got[i].request.NodeBin != f.paths.NodeBin || len(got[i].request.Keys) != 1 || len(got[i].request.Jobs) > 1 {
			t.Fatalf("child call %d did not receive the structured upgrade proof: %+v", i, got[i].request)
		}
		if got[i].request.Keys[0].Instance != layout.DefaultConnectorInstance || len(got[i].request.Keys[0].Public) != 64 {
			t.Fatalf("child call %d did not receive the public device identity: %+v", i, got[i].request.Keys)
		}
		if i < len(got)-1 || want[i].version == "v2.0.0" {
			if len(got[i].request.Jobs) != 1 || got[i].request.Jobs[0].Kind != launchd.Connector || got[i].request.Jobs[0].Instance != layout.DefaultConnectorInstance || got[i].request.Jobs[0].PID != 701 {
				t.Fatalf("child call %d did not receive the active connector identity: %+v", i, got[i].request.Jobs)
			}
		} else if len(got[i].request.Jobs) != 0 {
			t.Fatalf("rollback proof unexpectedly carried a service job: %+v", got[i].request.Jobs)
		}
	}
}
