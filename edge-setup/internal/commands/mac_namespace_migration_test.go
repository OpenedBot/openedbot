package commands

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

type macMigrationTestService struct {
	label, plist        string
	registered, running bool
	stops, starts       int
	stopErr             error
}

func (s *macMigrationTestService) Status(context.Context) (launchd.Status, error) {
	if s.running {
		return launchd.Status{Registered: true, Running: true, State: "running", PID: 42}, nil
	}
	if s.registered {
		return launchd.Status{Registered: true, State: "waiting"}, nil
	}
	return launchd.Status{}, nil
}

func (s *macMigrationTestService) Stop(context.Context) error {
	s.stops++
	if s.stopErr != nil {
		return s.stopErr
	}
	s.registered, s.running = false, false
	return nil
}

func (s *macMigrationTestService) StartInstalled(context.Context) error {
	s.starts++
	s.registered, s.running = true, true
	return nil
}

// Start bootstraps like launchd: an existing registration makes it fail.
func (s *macMigrationTestService) Start(context.Context) error {
	if s.registered {
		return errors.New("bootstrap: service already loaded")
	}
	if s.stopErr != nil {
		return s.stopErr
	}
	s.starts++
	s.registered, s.running = true, true
	return nil
}

func (s *macMigrationTestService) PlistPath() string { return s.plist }
func (s *macMigrationTestService) Label() string     { return s.label }

type macMigrationFixture struct {
	home             string
	current, legacy  layout.MacRuntimePaths
	services         map[string]*macMigrationTestService
	keyCalls         int
	keyErr           error
	registeredCalls  int
	serviceFactories int
	output           []string
}

func newMacMigrationFixture(t *testing.T) *macMigrationFixture {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	current, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := layout.MacRuntimeIn(layout.MacLegacy, home)
	if err != nil {
		t.Fatal(err)
	}
	macResetTestMkdir(t, filepath.Join(home, "Library", "Application Support"))
	return &macMigrationFixture{home: home, current: current, legacy: legacy, services: map[string]*macMigrationTestService{}}
}

// installLegacy lays out what a release from before the rename left: a
// running gateway, operator and default connector, their plists and logs,
// path-bound environments, and a ~/.local/bin alias to the old binary.
func (f *macMigrationFixture) installLegacy(t *testing.T) {
	t.Helper()
	l := f.legacy
	for _, dir := range []string{l.AppRoot, l.RuntimeRoot, l.ConnectorRoot, l.StateRoot, filepath.Dir(l.ExecutablePath),
		filepath.Join(l.AppRoot, "python", "cpython-3.11", "bin"), filepath.Join(l.VenvBin), filepath.Join(l.AppRoot, "python-bin"),
		filepath.Join(f.home, "Library", "LaunchAgents"), layout.MacLegacy.LogsIn(f.home), filepath.Join(f.home, ".local", "bin")} {
		macResetTestMkdir(t, dir)
	}
	macResetTestWrite(t, l.ToolConfig, "managed config fixture", 0o600)
	macResetTestWrite(t, l.RuntimeEnv, "API_SERVER_KEY=fixture\n", 0o600)
	macResetTestWrite(t, filepath.Join(l.RuntimeRoot, "config.yaml"), "workspace fixture\n", 0o600)
	macResetTestWrite(t, filepath.Join(l.ConnectorRoot, "link.json"), "{}", 0o600)
	macResetTestWrite(t, filepath.Join(l.InstallDir, ".git", "HEAD"), "checkout fixture", 0o600)
	macResetTestWrite(t, filepath.Join(l.VenvBin, "python"), "#!"+l.VenvBin+"/python3\n", 0o700)
	macResetTestWrite(t, l.ExecutablePath, "old binary", 0o700)
	if err := os.Symlink(l.ExecutablePath, filepath.Join(f.home, ".local", "bin", "edge-setup")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"gateway", "operator", "connector.default"} {
		label := layout.MacLegacy.LabelPrefix + name
		plist := filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")
		macResetTestWrite(t, plist, "legacy plist fixture", 0o600)
		macResetTestWrite(t, filepath.Join(layout.MacLegacy.LogsIn(f.home), label+".err.log"), "legacy log", 0o600)
		f.services[label] = &macMigrationTestService{label: label, plist: plist, registered: true, running: true}
	}
}

func (f *macMigrationFixture) deps() macMigrationDeps {
	return macMigrationDeps{
		Registered: func(context.Context) ([]layout.ConnectorInstance, error) {
			f.registeredCalls++
			var out []layout.ConnectorInstance
			if s := f.services[layout.MacLegacy.LabelPrefix+"connector.default"]; s != nil && s.registered {
				out = append(out, layout.DefaultConnectorInstance)
			}
			return out, nil
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macMigrationService, error) {
			f.serviceFactories++
			label := layout.MacLegacy.LabelPrefix + string(kind)
			if kind == launchd.Connector {
				label = layout.MacLegacy.LabelPrefix + "connector." + inst.Label()
			}
			s := f.services[label]
			if s == nil {
				s = &macMigrationTestService{label: label, plist: filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")}
				f.services[label] = s
			}
			return s, nil
		},
		MigrateKeys: func(context.Context) ([]layout.ConnectorInstance, error) {
			f.keyCalls++
			return nil, f.keyErr
		},
		Out:  func(format string, args ...any) { f.output = append(f.output, format) },
		Self: []byte("new release"),
	}
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return err == nil
}

func TestMacMigrationMovesALegacyOnlyInstallation(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	if err := refuseUnmovedMacLegacy(f.home); err == nil || !strings.Contains(err.Error(), "edge-setup up") {
		t.Fatalf("legacy-only host was not refused with guidance: %v", err)
	}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	c := f.current
	if exists(t, f.legacy.AppRoot) || exists(t, filepath.Dir(f.legacy.AppRoot)) {
		t.Fatal("legacy directory remains after the move")
	}
	for path, want := range map[string]string{c.ToolConfig: "managed config fixture", c.RuntimeEnv: "API_SERVER_KEY=fixture\n",
		filepath.Join(c.RuntimeRoot, "config.yaml"): "workspace fixture\n", filepath.Join(c.ConnectorRoot, "link.json"): "{}",
		filepath.Join(c.InstallDir, ".git", "HEAD"): "checkout fixture", c.ExecutablePath: "new release"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s was not moved intact: %q %v", path, got, err)
		}
	}
	for _, stale := range []string{filepath.Dir(c.VenvBin), filepath.Join(c.AppRoot, "python"), filepath.Join(c.AppRoot, "python-bin")} {
		if exists(t, stale) {
			t.Fatalf("path-bound environment %s was kept and would run from the old root", stale)
		}
	}
	for label, s := range f.services {
		if s.stops != 1 || s.registered || s.starts != 0 {
			t.Fatalf("legacy job %s was not stopped exactly once: %+v", label, s)
		}
		if exists(t, s.plist) {
			t.Fatalf("legacy plist %s remains", s.plist)
		}
	}
	if exists(t, layout.MacLegacy.LogsIn(f.home)) {
		t.Fatal("legacy log directory remains")
	}
	got, err := os.ReadFile(filepath.Join(layout.MacCurrent.LogsIn(f.home), layout.MacCurrent.LabelPrefix+"gateway.err.log"))
	if err != nil || string(got) != "legacy log" {
		t.Fatalf("legacy log was not renamed to its current label: %v", err)
	}
	link, err := os.Readlink(filepath.Join(f.home, ".local", "bin", "edge-setup"))
	if err != nil || link != c.ExecutablePath {
		t.Fatalf("installer alias = %q, %v; want %s", link, err, c.ExecutablePath)
	}
	if f.keyCalls != 1 {
		t.Fatal("legacy keychain items were not migrated")
	}
	var marker macNamespaceMarkerFile
	data, err := os.ReadFile(filepath.Join(c.AppRoot, macNamespaceMarker))
	if err != nil || json.Unmarshal(data, &marker) != nil {
		t.Fatalf("migration marker: %v", err)
	}
	if !marker.Rebuilt || !reflect.DeepEqual(marker.Restart, []layout.ConnectorInstance{layout.DefaultConnectorInstance}) {
		t.Fatalf("marker = %+v", marker)
	}
	if err := refuseUnmovedMacLegacy(f.home); err != nil {
		t.Fatalf("moved host still refused: %v", err)
	}

	// A second run (an up interrupted after the move) changes nothing.
	f.services = map[string]*macMigrationTestService{}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if f.registeredCalls != 1 || len(f.services) != 0 || !exists(t, c.RuntimeEnv) || f.keyCalls != 2 {
		t.Fatal("rerun touched launchd or the moved installation, or skipped the pending key step")
	}

	current := newMacRestartRecorder()
	if err := finishMacNamespaceMigration(context.Background(), c, current.service); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(current.started, []layout.ConnectorInstance{layout.DefaultConnectorInstance}) || exists(t, filepath.Join(c.AppRoot, macNamespaceMarker)) {
		t.Fatalf("running connector not restarted under its current label, or marker kept: %v", current.started)
	}
	if err := finishMacNamespaceMigration(context.Background(), c, current.service); err != nil || len(current.started) != 1 {
		t.Fatal("finishing twice restarted the connector again")
	}
}

func TestMacMigrationLeavesACurrentOnlyInstallationUnchanged(t *testing.T) {
	f := newMacMigrationFixture(t)
	macResetTestMkdir(t, f.current.RuntimeRoot)
	macResetTestWrite(t, f.current.RuntimeEnv, "current", 0o600)
	macResetTestMkdir(t, f.current.VenvBin)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if f.registeredCalls != 0 || f.serviceFactories != 0 || f.keyCalls != 0 {
		t.Fatal("current-only host queried legacy LaunchAgents or keychain items")
	}
	if !exists(t, f.current.RuntimeEnv) || !exists(t, f.current.VenvBin) {
		t.Fatal("current installation changed")
	}
	if exists(t, filepath.Dir(f.legacy.AppRoot)) || exists(t, layout.MacLegacy.LogsIn(f.home)) {
		t.Fatal("migration created a legacy path")
	}
}

func TestMacMigrationRefusesWhenBothInstallationsExist(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	macResetTestMkdir(t, f.current.RuntimeRoot)
	macResetTestWrite(t, f.current.RuntimeEnv, "current", 0o600)
	err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps())
	if err == nil || !strings.Contains(err.Error(), "nothing was moved") || !strings.Contains(err.Error(), f.legacy.AppRoot) || !strings.Contains(err.Error(), f.current.AppRoot) {
		t.Fatalf("both roots were not refused with both paths named: %v", err)
	}
	if got, _ := os.ReadFile(f.current.RuntimeEnv); string(got) != "current" {
		t.Fatal("current installation changed")
	}
	if !exists(t, f.legacy.RuntimeEnv) || !exists(t, f.legacy.VenvBin) {
		t.Fatal("legacy installation changed")
	}
	for _, s := range f.services {
		if s.stops != 0 || !s.running || !exists(t, s.plist) {
			t.Fatal("a legacy job was stopped or its plist removed")
		}
	}
	if f.keyCalls != 0 {
		t.Fatal("keys were migrated although the move was refused")
	}
}

func TestMacMigrationReplacesAnEmptyCurrentDirectory(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	macResetTestMkdir(t, f.current.AppRoot)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if !exists(t, f.current.RuntimeEnv) || exists(t, f.legacy.AppRoot) {
		t.Fatal("legacy installation was not moved over an empty current directory")
	}
}

func TestMacMigrationOnAFreshHostCreatesNothing(t *testing.T) {
	f := newMacMigrationFixture(t)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(f.home, "Library", "Application Support"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("fresh host gained %v", entries)
	}
	if exists(t, filepath.Join(f.home, "Library", "Logs")) || f.registeredCalls != 0 || f.keyCalls != 0 {
		t.Fatal("fresh host gained logs or queried launchd or the keychain")
	}
	if err := finishMacNamespaceMigration(context.Background(), f.current, func(layout.ConnectorInstance) (macRestartService, error) {
		return nil, errors.New("nothing to start")
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMacMigrationRestartsLegacyJobsWhenAStopFails(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	f.services[layout.MacLegacy.LabelPrefix+"gateway"].stopErr = errors.New("launchctl refused")
	err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps())
	if err == nil || !strings.Contains(err.Error(), "nothing was moved") {
		t.Fatalf("stop failure was not reported: %v", err)
	}
	if !exists(t, f.legacy.RuntimeEnv) || exists(t, f.current.AppRoot) {
		t.Fatal("installation moved after a failed stop")
	}
	for label, s := range f.services {
		if !s.running {
			t.Fatalf("legacy job %s was left stopped", label)
		}
	}
}

func TestMacMigrationRefusesAnInterruptedLegacyUpgrade(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	macResetTestWrite(t, filepath.Join(f.legacy.AppRoot, "upgrade-journal.json"), "{}", 0o600)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err == nil || !strings.Contains(err.Error(), "interrupted upgrade") {
		t.Fatalf("interrupted legacy upgrade was not refused: %v", err)
	}
	if exists(t, f.current.AppRoot) {
		t.Fatal("installation moved during an interrupted upgrade")
	}
}

func TestMacMigrationStopsWhenKeysCannotMove(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	f.keyErr = errors.New("instance default has different device keys under the legacy and current names; both were preserved")
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err == nil || err != f.keyErr {
		t.Fatalf("key conflict was not returned: %v", err)
	}
	f.keyErr = nil
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatalf("rerun after resolving the key conflict: %v", err)
	}
	if f.keyCalls != 2 || exists(t, filepath.Dir(f.current.VenvBin)) {
		t.Fatal("rerun did not resume the remaining steps")
	}
}

func TestMacResetRemovesALegacyInstallation(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	macResetTestWrite(t, macSetupLockPath(f.legacy), "", 0o600)
	keys := &macResetRuntimeKeyStore{instances: []layout.ConnectorInstance{layout.DefaultConnectorInstance}}
	deps := macResetDeps{Keys: keys,
		Registered: func(context.Context) ([]layout.ConnectorInstance, error) {
			var out []layout.ConnectorInstance
			if f.services[layout.MacLegacy.LabelPrefix+"connector.default"].registered {
				out = append(out, layout.DefaultConnectorInstance)
			}
			return out, nil
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macResetService, error) {
			s, err := f.deps().Service(kind, inst)
			if err != nil {
				return nil, err
			}
			return s.(*macMigrationTestService), nil
		},
	}
	present, err := macNamespacePresent(context.Background(), f.home, f.legacy, deps)
	if err != nil || !present {
		t.Fatalf("legacy installation not detected: %v", err)
	}
	o := reset.Options{PurgeData: true, DataLossAccepted: true}
	if err := resetMacRuntime(context.Background(), f.home, f.legacy, o, deps); err != nil {
		t.Fatal(err)
	}
	if err := removeMacLegacyLock(f.legacy); err != nil {
		t.Fatal(err)
	}
	if exists(t, filepath.Dir(f.legacy.AppRoot)) || exists(t, layout.MacLegacy.LogsIn(f.home)) || len(keys.instances) != 0 {
		t.Fatal("legacy directory, logs or keys remain after reset")
	}
	for _, s := range f.services {
		if s.registered || exists(t, s.plist) {
			t.Fatalf("legacy job %s remains", s.label)
		}
	}
	if present, err := macNamespacePresent(context.Background(), f.home, f.legacy, deps); err != nil || present {
		t.Fatalf("legacy namespace still detected after reset: %v", err)
	}
	if err := removeMacLegacyLock(f.current); err == nil {
		t.Fatal("the current coordination lock was treated as legacy")
	}
}

func TestMacMigrationDropsAnEmptyLegacyDirectory(t *testing.T) {
	f := newMacMigrationFixture(t)
	macResetTestMkdir(t, f.legacy.AppRoot)
	macResetTestMkdir(t, f.current.RuntimeRoot)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if exists(t, filepath.Dir(f.legacy.AppRoot)) || !exists(t, f.current.RuntimeRoot) || f.registeredCalls != 0 {
		t.Fatal("an empty legacy directory was not simply dropped")
	}
}

// In the tests below a failing step stands in for a process killed there.

func TestMacMigrationResumesCleanupAfterACrashFollowingTheRename(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	// The key step is the first one after the rename.
	f.keyErr = errors.New("killed")
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err == nil {
		t.Fatal("simulated crash did not stop the run")
	}
	// Put back what a crash before the cleanup would have left.
	for _, s := range f.services {
		macResetTestWrite(t, s.plist, "legacy plist fixture", 0o600)
	}
	alias := filepath.Join(f.home, ".local", "bin", "edge-setup")
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(f.legacy.ExecutablePath, alias); err != nil {
		t.Fatal(err)
	}
	if exists(t, f.legacy.AppRoot) || !exists(t, filepath.Join(f.current.AppRoot, macNamespaceMarker)) {
		t.Fatal("fixture is not in the after-rename state")
	}
	f.keyErr = nil
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	for _, s := range f.services {
		if exists(t, s.plist) {
			t.Fatalf("legacy plist %s survived the resumed run", s.plist)
		}
	}
	if link, err := os.Readlink(alias); err != nil || link != f.current.ExecutablePath {
		t.Fatalf("alias = %q, %v after the resumed run", link, err)
	}
	if !exists(t, filepath.Join(f.current.AppRoot, macNamespaceMarker)) {
		t.Fatal("marker removed before up finished")
	}
	current := newMacRestartRecorder()
	if err := finishMacNamespaceMigration(context.Background(), f.current, current.service); err != nil {
		t.Fatal(err)
	}
	started := current.started
	if len(started) != 1 || exists(t, filepath.Join(f.current.AppRoot, macNamespaceMarker)) {
		t.Fatal("marker kept or connector not restarted at the end")
	}
}

func TestMacMigrationKeepsTheRestartInventoryAcrossACrashAfterStopping(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	// Besides the default connector, a second linked connector runs.
	work := layout.ConnectorInstance("work")
	macResetTestWrite(t, filepath.Join(work.DirUnder(f.legacy.ConnectorRoot), "link.json"), "{}", 0o600)
	macResetTestMkdir(t, work.DirUnder(f.legacy.StateRoot))
	label := layout.MacLegacy.LabelPrefix + "connector.work"
	plist := filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")
	macResetTestWrite(t, plist, "legacy plist fixture", 0o600)
	f.services[label] = &macMigrationTestService{label: label, plist: plist, registered: true, running: true}
	// The gateway is stopped last: the connectors are already stopped.
	f.services[layout.MacLegacy.LabelPrefix+"gateway"].stopErr = errors.New("killed")
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err == nil {
		t.Fatal("simulated crash did not stop the run")
	}
	// A killed process restarts nothing: every job is left stopped.
	for _, s := range f.services {
		s.registered, s.running, s.stopErr = false, false, nil
	}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	current := newMacRestartRecorder()
	if err := finishMacNamespaceMigration(context.Background(), f.current, current.service); err != nil {
		t.Fatal(err)
	}
	started := current.started
	want := []layout.ConnectorInstance{layout.DefaultConnectorInstance, work}
	if !reflect.DeepEqual(started, want) {
		t.Fatalf("restarted %q after resuming, want the originally running %q", started, want)
	}
}

func TestMacUpReadsItsOwnBinaryBeforeTheMigrationMovesIt(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	// The new release was copied over the legacy installed path and run from there.
	running := f.legacy.ExecutablePath
	macResetTestWrite(t, running, "new release", 0o700)
	self, err := readMacSelf(func() (string, error) { return running, nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if _, err := copyMacBinary(running, f.current.ExecutablePath); err == nil {
		t.Fatal("startup path still readable: this test no longer reproduces the move")
	}
	if _, err := installMacBinary(self, f.current.ExecutablePath); err != nil {
		t.Fatalf("binary read before the move could not be installed: %v", err)
	}
	if got, err := os.ReadFile(f.current.ExecutablePath); err != nil || string(got) != "new release" {
		t.Fatalf("installed binary = %q, %v", got, err)
	}
	if _, err := installMacBinary(nil, f.current.ExecutablePath); err == nil {
		t.Fatal("an empty binary was installed")
	}
}

type macRestartRecorder struct {
	services map[layout.ConnectorInstance]*macMigrationTestService
	started  []layout.ConnectorInstance
	failOn   layout.ConnectorInstance
}

func newMacRestartRecorder() *macRestartRecorder {
	return &macRestartRecorder{services: map[layout.ConnectorInstance]*macMigrationTestService{}, failOn: "-"}
}

func (r *macRestartRecorder) service(inst layout.ConnectorInstance) (macRestartService, error) {
	s := r.services[inst]
	if s == nil {
		s = &macMigrationTestService{label: layout.MacCurrent.LabelPrefix + "connector." + inst.Label()}
		r.services[inst] = s
	}
	return &recordingStart{s, r, inst}, nil
}

type recordingStart struct {
	*macMigrationTestService
	r    *macRestartRecorder
	inst layout.ConnectorInstance
}

func (s *recordingStart) Start(ctx context.Context) error {
	if s.inst == s.r.failOn {
		return errors.New("killed")
	}
	if err := s.macMigrationTestService.Start(ctx); err != nil {
		return err
	}
	s.r.started = append(s.r.started, s.inst)
	return nil
}

func TestMacMigrationCompletionResumesAfterSomeConnectorsStarted(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	work := layout.ConnectorInstance("work")
	macResetTestWrite(t, filepath.Join(work.DirUnder(f.legacy.ConnectorRoot), "link.json"), "{}", 0o600)
	macResetTestMkdir(t, work.DirUnder(f.legacy.StateRoot))
	label := layout.MacLegacy.LabelPrefix + "connector.work"
	plist := filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")
	macResetTestWrite(t, plist, "legacy plist fixture", 0o600)
	f.services[label] = &macMigrationTestService{label: label, plist: plist, registered: true, running: true}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	current := newMacRestartRecorder()
	// Killed after starting the default connector, before "work".
	current.failOn = work
	if err := finishMacNamespaceMigration(context.Background(), f.current, current.service); err == nil {
		t.Fatal("simulated crash did not stop the completion")
	}
	current.failOn = "-"
	if err := finishMacNamespaceMigration(context.Background(), f.current, current.service); err != nil {
		t.Fatalf("completion did not resume past an already started connector: %v", err)
	}
	if !reflect.DeepEqual(current.started, []layout.ConnectorInstance{layout.DefaultConnectorInstance, work}) {
		t.Fatalf("started %q", current.started)
	}
	if exists(t, filepath.Join(f.current.AppRoot, macNamespaceMarker)) {
		t.Fatal("marker kept after a completed restart")
	}
}

func TestMacMigrationInstallsTheRunningReleaseBeforeAnyFallibleStep(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	// The keychain is locked: the key step fails after the rename.
	f.keyErr = errors.New("keychain locked")
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err == nil {
		t.Fatal("key failure was not reported")
	}
	alias := filepath.Join(f.home, ".local", "bin", "edge-setup")
	target, err := os.Readlink(alias)
	if err != nil || target != f.current.ExecutablePath {
		t.Fatalf("alias resolves to %q, %v", target, err)
	}
	if got, err := os.ReadFile(alias); err != nil || string(got) != "new release" {
		t.Fatalf("alias runs %q (%v): a retry would run the pre-rename release", got, err)
	}
	// A retry through the alias is this release: it resumes the migration.
	f.keyErr = nil
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if exists(t, f.legacy.AppRoot) || exists(t, filepath.Dir(f.legacy.AppRoot)) {
		t.Fatal("the retry recreated the legacy namespace")
	}
	// An earlier run that stopped before installing is caught up on resume.
	macResetTestWrite(t, f.current.ExecutablePath, "old binary", 0o700)
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(f.current.ExecutablePath); string(got) != "new release" {
		t.Fatal("resumed run did not reinstall the running release")
	}
	if pending, err := macMigrationPending(f.current); err != nil || !pending {
		t.Fatal("migration should stay pending until up finishes")
	}
	deps := f.deps()
	deps.Self = nil
	if err := migrateMacLegacyNamespace(context.Background(), f.home, deps); err == nil {
		t.Fatal("migration ran without the running release")
	}
}

func TestMacMigrationRestartsAThrottledRegisteredConnector(t *testing.T) {
	f := newMacMigrationFixture(t)
	f.installLegacy(t)
	work := layout.ConnectorInstance("work")
	macResetTestWrite(t, filepath.Join(work.DirUnder(f.legacy.ConnectorRoot), "link.json"), "{}", 0o600)
	macResetTestMkdir(t, work.DirUnder(f.legacy.StateRoot))
	label := layout.MacLegacy.LabelPrefix + "connector.work"
	plist := filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")
	macResetTestWrite(t, plist, "legacy plist fixture", 0o600)
	// Registered but not running: launchd throttles it after a crash.
	f.services[label] = &macMigrationTestService{label: label, plist: plist, registered: true}
	if err := migrateMacLegacyNamespace(context.Background(), f.home, f.deps()); err != nil {
		t.Fatal(err)
	}
	if exists(t, plist) || f.services[label].registered {
		t.Fatal("throttled legacy connector was not unloaded")
	}
	current := newMacRestartRecorder()
	if err := finishMacNamespaceMigration(context.Background(), f.current, current.service); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(current.started, []layout.ConnectorInstance{layout.DefaultConnectorInstance, work}) {
		t.Fatalf("started %q, want the throttled connector restarted too", current.started)
	}
}

func TestMacResetDetectsLegacyGatewayAndOperatorJobsAlone(t *testing.T) {
	for _, kind := range []launchd.Kind{launchd.Gateway, launchd.Operator} {
		f := newMacMigrationFixture(t)
		keys := &macResetRuntimeKeyStore{}
		label := layout.MacLegacy.LabelPrefix + string(kind)
		job := &macMigrationTestService{label: label, plist: filepath.Join(f.home, "Library", "LaunchAgents", label+".plist"), registered: true, running: true}
		deps := macResetDeps{Keys: keys,
			Registered: func(context.Context) ([]layout.ConnectorInstance, error) { return nil, nil },
			Service: func(k launchd.Kind, inst layout.ConnectorInstance) (macResetService, error) {
				if k == kind {
					return job, nil
				}
				return &macMigrationTestService{label: layout.MacLegacy.LabelPrefix + string(k)}, nil
			},
		}
		present, err := macNamespacePresent(context.Background(), f.home, f.legacy, deps)
		if err != nil || !present {
			t.Fatalf("legacy %s job registered alone was not detected: %v", kind, err)
		}
		job.registered, job.running = false, false
		if present, err := macNamespacePresent(context.Background(), f.home, f.legacy, deps); err != nil || present {
			t.Fatalf("nothing left, yet %s reported present: %v", kind, err)
		}
	}
}
