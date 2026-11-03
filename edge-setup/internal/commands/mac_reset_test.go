package commands

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

type macResetRuntimeKeyStore struct {
	instances    []layout.ConnectorInstance
	removed      []layout.ConnectorInstance
	reads        int
	readErrorAt  int
	removeErrors map[layout.ConnectorInstance]error
	events       *[]string
	beforeRemove func(layout.ConnectorInstance) error
}

func (s *macResetRuntimeKeyStore) Instances(context.Context) ([]layout.ConnectorInstance, error) {
	s.reads++
	if s.events != nil {
		*s.events = append(*s.events, "keys:inventory")
	}
	if s.reads == s.readErrorAt {
		return nil, errors.New("private keychain inventory transcript")
	}
	return append([]layout.ConnectorInstance(nil), s.instances...), nil
}

func (s *macResetRuntimeKeyStore) Remove(_ context.Context, instance layout.ConnectorInstance) error {
	if s.events != nil {
		*s.events = append(*s.events, "keys:remove:"+instance.Label())
	}
	if s.beforeRemove != nil {
		if err := s.beforeRemove(instance); err != nil {
			return err
		}
	}
	if err := s.removeErrors[instance]; err != nil {
		return err
	}
	for i, current := range s.instances {
		if current == instance {
			s.instances = append(s.instances[:i], s.instances[i+1:]...)
			break
		}
	}
	s.removed = append(s.removed, instance)
	return nil
}

var _ devicekeys.ResetStore = (*macResetRuntimeKeyStore)(nil)

type macResetRuntimeService struct {
	label               string
	plist               string
	tracker             *macResetRuntimeTracker
	stopError           error
	statusCalls         int
	statusErrorAt       int
	registeredAfterStop bool
}

func (s *macResetRuntimeService) Stop(context.Context) error {
	s.tracker.events = append(s.tracker.events, "stop:"+s.label)
	if s.tracker.preflightStatuses != len(s.tracker.services) {
		s.tracker.orderErrors = append(s.tracker.orderErrors, "stop started before every service was preflighted")
	}
	s.tracker.stops++
	return s.stopError
}

func (s *macResetRuntimeService) Status(context.Context) (launchd.Status, error) {
	s.statusCalls++
	if s.statusCalls == 1 {
		s.tracker.preflightStatuses++
		s.tracker.events = append(s.tracker.events, "preflight:"+s.label)
	} else {
		s.tracker.events = append(s.tracker.events, "readback:"+s.label)
	}
	if s.statusCalls == s.statusErrorAt {
		return launchd.Status{}, errors.New("private launchctl status transcript")
	}
	if s.statusCalls == 1 && s.tracker.installed {
		return launchd.Status{Registered: true, Running: true, State: "running", PID: 701}, nil
	}
	if s.statusCalls > 1 && s.registeredAfterStop {
		return launchd.Status{Registered: true, Running: true, State: "running", PID: 701}, nil
	}
	return launchd.Status{}, nil
}

func (s *macResetRuntimeService) PlistPath() string { return s.plist }
func (s *macResetRuntimeService) Label() string     { return s.label }

var _ macResetService = (*macResetRuntimeService)(nil)

type macResetRuntimeTracker struct {
	services          map[string]*macResetRuntimeService
	preflightStatuses int
	stops             int
	installed         bool
	events            []string
	orderErrors       []string
}

type macResetRuntimeFixture struct {
	home                 string
	paths                layout.MacRuntimePaths
	keys                 *macResetRuntimeKeyStore
	tracker              *macResetRuntimeTracker
	registeredInitial    []layout.ConnectorInstance
	registeredFinal      []layout.ConnectorInstance
	registeredCalls      int
	registeredErrorAt    int
	registeredError      error
	servicePathOverride  map[string]string
	serviceLabelOverride map[string]string
	serviceCalls         int
	output               []string
}

func newMacResetRuntimeFixture(t *testing.T, installed bool, keys, registered, disk, plistInstances []layout.ConnectorInstance) *macResetRuntimeFixture {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	f := &macResetRuntimeFixture{home: home, paths: paths, registeredInitial: append([]layout.ConnectorInstance(nil), registered...),
		servicePathOverride: map[string]string{}, serviceLabelOverride: map[string]string{}}
	if installed {
		for _, dir := range []string{paths.AppRoot, paths.RuntimeRoot, paths.ConnectorRoot, paths.StateRoot,
			filepath.Join(home, "Library", "LaunchAgents"), filepath.Join(home, "Library", "Logs", "OpenHermesBot")} {
			macResetTestMkdir(t, dir)
		}
		macResetTestWrite(t, filepath.Join(paths.AppRoot, "config.json"), "managed config fixture", 0o600)
		macResetTestWrite(t, macSetupLockPath(paths), "", 0o600)
		macResetTestWrite(t, paths.RuntimeEnv, "runtime credential fixture", 0o600)
		macResetTestWrite(t, filepath.Join(paths.ConnectorRoot, "link.json"), "link fixture", 0o600)
		macResetTestWrite(t, filepath.Join(paths.StateRoot, "state.json"), "state fixture", 0o600)
		for _, inst := range disk {
			for _, root := range []string{paths.ConnectorRoot, paths.StateRoot} {
				dir := inst.DirUnder(root)
				macResetTestMkdir(t, dir)
				macResetTestWrite(t, filepath.Join(dir, "fixture.json"), "instance directory fixture", 0o600)
			}
		}
		macResetTestWrite(t, filepath.Join(home, ".hermes", "config.yaml"), "personal Hermes fixture", 0o600)
		macResetTestWrite(t, filepath.Join(home, "Library", "LaunchAgents", "ai.hermes.plist"), "personal launch agent fixture", 0o600)
		macResetTestWrite(t, filepath.Join(home, "Library", "Application Support", "OtherApp", "keep"), "other application fixture", 0o600)
	}

	allInstances := map[layout.ConnectorInstance]bool{layout.DefaultConnectorInstance: true}
	for _, group := range [][]layout.ConnectorInstance{keys, registered, disk, plistInstances} {
		for _, inst := range group {
			allInstances[inst] = true
		}
	}
	instances := make([]layout.ConnectorInstance, 0, len(allInstances))
	for inst := range allInstances {
		instances = append(instances, inst)
	}
	sort.Slice(instances, func(i, j int) bool { return instances[i] < instances[j] })
	f.tracker = &macResetRuntimeTracker{services: map[string]*macResetRuntimeService{}, installed: installed}
	addService := func(kind launchd.Kind, inst layout.ConnectorInstance, createFiles bool) {
		label, plist := macResetTestServicePaths(t, home, paths, kind, inst)
		s := &macResetRuntimeService{label: label, plist: plist, tracker: f.tracker}
		f.tracker.services[label] = s
		if installed && createFiles {
			macResetTestWrite(t, plist, "managed plist fixture", 0o600)
			logDir := filepath.Join(home, "Library", "Logs", "OpenHermesBot")
			macResetTestWrite(t, filepath.Join(logDir, label+".out.log"), "stdout fixture", 0o600)
			macResetTestWrite(t, filepath.Join(logDir, label+".err.log"), "stderr fixture", 0o600)
		}
	}
	for _, inst := range instances {
		create := inst.IsDefault()
		for _, plistInst := range plistInstances {
			create = create || plistInst == inst
		}
		addService(launchd.Connector, inst, create)
	}
	addService(launchd.Operator, layout.DefaultConnectorInstance, true)
	addService(launchd.Gateway, layout.DefaultConnectorInstance, true)

	f.keys = &macResetRuntimeKeyStore{instances: append([]layout.ConnectorInstance(nil), keys...), removeErrors: map[layout.ConnectorInstance]error{}, events: &f.tracker.events}
	f.keys.beforeRemove = func(layout.ConnectorInstance) error {
		if f.tracker.stops != len(f.tracker.services) {
			return errors.New("not every managed service was stopped")
		}
		for _, service := range f.tracker.services {
			if service.statusCalls < 2 {
				return errors.New("not every managed service stop was read back")
			}
		}
		return nil
	}
	return f
}

func (f *macResetRuntimeFixture) deps() macResetDeps {
	return macResetDeps{
		Keys: f.keys,
		Registered: func(context.Context) ([]layout.ConnectorInstance, error) {
			f.registeredCalls++
			f.tracker.events = append(f.tracker.events, "jobs:inventory")
			if f.registeredCalls == f.registeredErrorAt {
				return nil, f.registeredError
			}
			if f.registeredCalls == 1 {
				return append([]layout.ConnectorInstance(nil), f.registeredInitial...), nil
			}
			return append([]layout.ConnectorInstance(nil), f.registeredFinal...), nil
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macResetService, error) {
			f.serviceCalls++
			label := macResetRuntimeServiceLabel(kind, inst)
			service := f.tracker.services[label]
			if service == nil {
				return nil, errors.New("unexpected service factory request")
			}
			if path, ok := f.servicePathOverride[label]; ok {
				service.plist = path
			}
			if override, ok := f.serviceLabelOverride[label]; ok {
				service.label = override
			}
			return service, nil
		},
		Out: func(format string, args ...any) { f.output = append(f.output, fmt.Sprintf(format, args...)) },
	}
}

func macResetRuntimeServiceLabel(kind launchd.Kind, inst layout.ConnectorInstance) string {
	if kind == launchd.Connector {
		return macResetLabelPrefix + "connector." + inst.Label()
	}
	return macResetLabelPrefix + string(kind)
}

func macResetTestServicePaths(t *testing.T, home string, paths layout.MacRuntimePaths, kind launchd.Kind, inst layout.ConnectorInstance) (string, string) {
	t.Helper()
	binary := paths.ExecutablePath
	cfg := launchd.Config{Runner: exectest.NewFake(), LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
		ExecutablePath: binary, CredentialsDirectory: inst.DirUnder(paths.ConnectorRoot), StateDirectory: inst.DirUnder(paths.StateRoot),
		Instance: inst, Kind: kind, RuntimeRoot: paths.RuntimeRoot, VenvBin: paths.VenvBin, NodeBin: paths.NodeBin}
	client, err := launchd.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return client.Label(), client.PlistPath()
}

func macResetTestMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func macResetTestWrite(t *testing.T, path, value string, mode os.FileMode) {
	t.Helper()
	macResetTestMkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(value), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestResetMacRuntimeStopsAndVerifiesBeforeRemovingKeys(t *testing.T) {
	keys := []layout.ConnectorInstance{layout.DefaultConnectorInstance, "key-only"}
	registered := []layout.ConnectorInstance{"loaded-only"}
	disk := []layout.ConnectorInstance{"disk-only"}
	plists := []layout.ConnectorInstance{"plist-only"}
	f := newMacResetRuntimeFixture(t, true, keys, registered, disk, plists)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if len(f.tracker.orderErrors) != 0 {
		t.Fatalf("service order violations: %v", f.tracker.orderErrors)
	}
	if f.keys.reads < 3 || len(f.keys.instances) != 0 {
		t.Fatalf("key inventory calls=%d remaining=%v", f.keys.reads, f.keys.instances)
	}
	wantRemoved := []layout.ConnectorInstance{layout.DefaultConnectorInstance, "key-only"}
	gotRemoved := append([]layout.ConnectorInstance(nil), f.keys.removed...)
	sort.Slice(gotRemoved, func(i, j int) bool { return gotRemoved[i] < gotRemoved[j] })
	if !reflect.DeepEqual(gotRemoved, wantRemoved) {
		t.Fatalf("removed keys=%v, want %v", gotRemoved, wantRemoved)
	}
	for _, name := range []string{"default", "disk-only", "key-only", "loaded-only", "plist-only"} {
		if _, ok := f.tracker.services[macResetTestConnectorLabel(name)]; !ok {
			t.Errorf("connector instance %q was absent from the service union", name)
		}
	}
	if len(f.registeredFinal) != 0 {
		t.Fatal("fixture final registration inventory was not empty")
	}
	for label := range f.tracker.services {
		if info, err := os.Lstat(filepath.Join(f.home, "Library", "LaunchAgents", label+".plist")); !os.IsNotExist(err) || info != nil {
			t.Errorf("managed plist %q remains after reset", label)
		}
		for _, suffix := range []string{".out.log", ".err.log"} {
			if _, err := os.Lstat(filepath.Join(f.home, "Library", "Logs", "OpenHermesBot", label+suffix)); !os.IsNotExist(err) {
				t.Errorf("managed log %q remains after reset", label+suffix)
			}
		}
	}
	if data, err := os.ReadFile(f.paths.RuntimeEnv); err != nil || string(data) != "runtime credential fixture" {
		t.Fatal("normal reset did not preserve the Hermes runtime data")
	}
	if data, err := os.ReadFile(filepath.Join(f.home, ".hermes", "config.yaml")); err != nil || string(data) != "personal Hermes fixture" {
		t.Fatal("normal reset altered the user's personal Hermes installation")
	}
	if data, err := os.ReadFile(filepath.Join(f.home, "Library", "LaunchAgents", "ai.hermes.plist")); err != nil || string(data) != "personal launch agent fixture" {
		t.Fatal("normal reset altered the personal Hermes LaunchAgent")
	}
	if data, err := os.ReadFile(filepath.Join(f.home, "Library", "Application Support", "OtherApp", "keep")); err != nil || string(data) != "other application fixture" {
		t.Fatal("normal reset altered another application's data")
	}
	entries, err := os.ReadDir(f.paths.AppRoot)
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(f.paths.RuntimeRoot) {
		t.Fatalf("remaining managed AppRoot entries=%v err=%v, want runtime only", entries, err)
	}
}

func macResetTestConnectorLabel(name string) string {
	return macResetLabelPrefix + "connector." + name
}

func TestResetMacRuntimeFailuresPreserveFilesAndKeys(t *testing.T) {
	private := "private-reset-diagnostic"
	for _, tc := range []struct {
		name  string
		setup func(*macResetRuntimeFixture)
	}{
		{name: "stop fails", setup: func(f *macResetRuntimeFixture) {
			f.tracker.services[macResetLabelPrefix+"gateway"].stopError = errors.New(private)
		}},
		{name: "readback fails", setup: func(f *macResetRuntimeFixture) {
			f.tracker.services[macResetTestConnectorLabel("default")].statusErrorAt = 2
		}},
		{name: "still registered after stop", setup: func(f *macResetRuntimeFixture) {
			f.tracker.services[macResetTestConnectorLabel("default")].registeredAfterStop = true
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{layout.DefaultConnectorInstance, "dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
			tc.setup(f)
			before := macResetTestSnapshot(t, f.home)
			err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps())
			if err == nil {
				t.Fatal("reset succeeded without a complete stop proof")
			}
			if strings.Contains(err.Error(), private) || strings.Contains(err.Error(), "private launchctl") {
				t.Fatal("private service diagnostics escaped into the reset error")
			}
			if len(f.keys.removed) != 0 || len(f.keys.instances) != 2 {
				t.Fatalf("keys changed before service stop proof: removed=%v remaining=%v", f.keys.removed, f.keys.instances)
			}
			if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
				t.Fatal("metadata, LaunchAgents or runtime files changed after failed service proof")
			}
		})
	}
}

func TestResetMacRuntimePreflightsEveryServiceAndOwnedFileBeforeStopping(t *testing.T) {
	t.Run("last service status is unknown", func(t *testing.T) {
		f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
		f.tracker.services[macResetLabelPrefix+"gateway"].statusErrorAt = 1
		before := macResetTestSnapshot(t, f.home)
		if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err == nil {
			t.Fatal("reset accepted an unknown gateway status")
		}
		if f.tracker.stops != 0 || len(f.keys.removed) != 0 {
			t.Fatal("reset began stopping services before all statuses were preflighted")
		}
		if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
			t.Fatal("reset changed files after a failed status preflight")
		}
	})

	t.Run("last service plist is unsafe", func(t *testing.T) {
		f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
		gatewayPlist := f.tracker.services[macResetLabelPrefix+"gateway"].plist
		if err := os.Chmod(gatewayPlist, 0o644); err != nil {
			t.Fatal(err)
		}
		before := macResetTestSnapshot(t, f.home)
		if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err == nil {
			t.Fatal("reset accepted a non-private managed plist")
		}
		if f.tracker.stops != 0 || len(f.keys.removed) != 0 {
			t.Fatal("reset began stopping services before every managed plist was checked")
		}
		if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
			t.Fatal("reset changed files after a failed plist preflight")
		}
	})
}

func TestResetMacRuntimeKeyFailuresDoNotDeleteInstallationFiles(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*macResetRuntimeFixture)
	}{
		{name: "key removal error", setup: func(f *macResetRuntimeFixture) {
			f.keys.removeErrors[layout.ConnectorInstance("dev")] = errors.New("private keychain removal transcript")
		}},
		{name: "key inventory readback error", setup: func(f *macResetRuntimeFixture) {
			f.keys.readErrorAt = 2
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
			tc.setup(f)
			before := macResetTestSnapshot(t, f.home)
			err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps())
			if err == nil {
				t.Fatal("reset succeeded without device-key removal proof")
			}
			if strings.Contains(err.Error(), "private") {
				t.Fatal("private keychain diagnostic escaped into the reset error")
			}
			if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
				t.Fatal("filesystem deletion began before key removal was proved")
			}
		})
	}
}

func TestResetMacRuntimePlanIsReadOnly(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
	before := macResetTestSnapshot(t, f.home)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{Plan: true}, f.deps()); err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(f.keys.removed) != 0 || f.tracker.stops != 0 {
		t.Fatal("plan stopped a service or removed a key")
	}
	if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
		t.Fatal("plan changed the filesystem")
	}
	if len(f.output) == 0 {
		t.Fatal("plan did not describe the inspected reset")
	}
}

func TestResetMacRuntimeRejectsUnsupportedOptionsBeforeDependencies(t *testing.T) {
	options := []struct {
		name string
		set  func(*reset.Options)
	}{
		{name: "package purge", set: func(o *reset.Options) { o.PurgePackages = true }},
		{name: "legacy purge", set: func(o *reset.Options) { o.Legacy = true }},
		{name: "tailscale purge", set: func(o *reset.Options) { o.PurgeTailscale = true }},
		{name: "admin removal", set: func(o *reset.Options) { o.RemoveAdmin = true }},
		{name: "cloud user restore", set: func(o *reset.Options) { o.RestoreCloudUser = true }},
		{name: "unconfirmed data purge", set: func(o *reset.Options) { o.PurgeData = true }},
	}
	for _, tc := range options {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacResetRuntimeFixture(t, false, nil, nil, nil, nil)
			var opts reset.Options
			tc.set(&opts)
			if err := resetMacRuntime(context.Background(), f.home, f.paths, opts, f.deps()); err == nil {
				t.Fatal("unsupported or unconfirmed reset option was accepted")
			}
			if f.registeredCalls != 0 || f.keys.reads != 0 || f.serviceCalls != 0 || f.tracker.stops != 0 {
				t.Fatal("unsupported options reached reset dependencies")
			}
		})
	}
}

func TestResetMacRuntimePurgeDataIsExplicitAndScoped(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, nil, nil, nil, nil)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{PurgeData: true, DataLossAccepted: true}, f.deps()); err != nil {
		t.Fatalf("confirmed purge: %v", err)
	}
	if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
		t.Fatal("confirmed purge left the managed application root")
	}
	for _, path := range []string{
		filepath.Join(f.home, ".hermes", "config.yaml"),
		filepath.Join(f.home, "Library", "LaunchAgents", "ai.hermes.plist"),
		filepath.Join(f.home, "Library", "Application Support", "OtherApp", "keep"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("confirmed runtime purge crossed the managed boundary at %q: %v", path, err)
		}
	}
}

func TestResetMacRuntimeAbsentInstallationIsIdempotent(t *testing.T) {
	f := newMacResetRuntimeFixture(t, false, nil, nil, nil, nil)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err != nil {
		t.Fatalf("reset of absent installation: %v", err)
	}
	if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
		t.Fatal("reset created an application root for an absent installation")
	}
	if len(f.keys.removed) != 0 {
		t.Fatal("absent installation caused device-key removal")
	}
}

func TestResetMacRuntimeRejectsUnsafeRootsBeforeMutation(t *testing.T) {
	for _, tc := range []struct {
		name string
		root func(*testing.T, *macResetRuntimeFixture) string
	}{
		{name: "application root symlink", root: func(t *testing.T, f *macResetRuntimeFixture) string {
			target := t.TempDir()
			if err := os.RemoveAll(f.paths.AppRoot); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, f.paths.AppRoot); err != nil {
				t.Fatal(err)
			}
			return target
		}},
		{name: "connector root symlink", root: func(t *testing.T, f *macResetRuntimeFixture) string {
			target := t.TempDir()
			macResetTestWrite(t, filepath.Join(target, "link.json"), "untouched", 0o600)
			if err := os.RemoveAll(f.paths.ConnectorRoot); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, f.paths.ConnectorRoot); err != nil {
				t.Fatal(err)
			}
			return target
		}},
		{name: "runtime root symlink", root: func(t *testing.T, f *macResetRuntimeFixture) string {
			target := t.TempDir()
			macResetTestWrite(t, filepath.Join(target, "keep"), "untouched", 0o600)
			if err := os.RemoveAll(f.paths.RuntimeRoot); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, f.paths.RuntimeRoot); err != nil {
				t.Fatal(err)
			}
			return target
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
			target := tc.root(t, f)
			if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err == nil {
				t.Fatal("unsafe symlink root was accepted")
			}
			if f.tracker.stops != 0 || len(f.keys.removed) != 0 {
				t.Fatal("unsafe roots reached service stop or key removal")
			}
			if target != "" {
				if strings.Contains(tc.name, "connector") {
					if data, err := os.ReadFile(filepath.Join(target, "link.json")); err != nil || string(data) != "untouched" {
						t.Fatal("connector symlink target was modified")
					}
				} else if strings.Contains(tc.name, "runtime") {
					if data, err := os.ReadFile(filepath.Join(target, "keep")); err != nil || string(data) != "untouched" {
						t.Fatal("runtime symlink target was modified")
					}
				}
			}
		})
	}
}

func TestResetMacRuntimeRejectsEscapingServiceIdentity(t *testing.T) {
	for _, tc := range []struct {
		name  string
		apply func(*macResetRuntimeFixture, string)
	}{
		{name: "plist path", apply: func(f *macResetRuntimeFixture, label string) {
			f.servicePathOverride[label] = filepath.Join(f.home, ".hermes", "outside.plist")
		}},
		{name: "label", apply: func(f *macResetRuntimeFixture, label string) {
			f.serviceLabelOverride[label] = "ai.hermes.gateway"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
			label := macResetLabelPrefix + "gateway"
			tc.apply(f, label)
			if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err == nil {
				t.Fatal("service identity outside the fixed managed namespace was accepted")
			}
			if f.tracker.stops != 0 || len(f.keys.removed) != 0 {
				t.Fatal("invalid service identity reached a destructive action")
			}
		})
	}
}

func macResetTestSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		value := info.Mode().String()
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += ":" + string(data)
		}
		out[rel] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
