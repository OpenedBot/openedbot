package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// Releases before the product rename installed the macOS runtime under
// layout.MacLegacy. up moves such an installation once into layout.MacCurrent:
//
//	stop legacy jobs -> marker -> rename root -> drop legacy plists
//	-> keychain items -> logs -> rebuild path-bound environments
//	-> up re-renders and starts the current jobs -> marker removed
//
// The directory is renamed in place (same volume), never copied or deleted.
// Each step is idempotent, so an interrupted up resumes on the next run.

const macNamespaceMarker = "namespace-migration.json"

type macNamespaceMarkerFile struct {
	// Restart lists connectors registered under their legacy label, running
	// or not (launchd may be throttling one after a crash).
	Restart []layout.ConnectorInstance `json:"restart"`
	// Rebuilt is set once path-bound environments were removed.
	Rebuilt bool `json:"rebuilt"`
}

type macMigrationService interface {
	Status(context.Context) (launchd.Status, error)
	Stop(context.Context) error
	StartInstalled(context.Context) error
	PlistPath() string
	Label() string
}

type macMigrationDeps struct {
	// Registered lists connector instances with a loaded legacy label.
	Registered func(context.Context) ([]layout.ConnectorInstance, error)
	// Service addresses one job under its legacy label.
	Service func(launchd.Kind, layout.ConnectorInstance) (macMigrationService, error)
	// MigrateKeys moves keychain items to the current service name.
	MigrateKeys func(context.Context) ([]layout.ConnectorInstance, error)
	// Self is the running release, read before anything moved.
	Self []byte
	Out  func(string, ...any)
}

func (d macMigrationDeps) printf(format string, args ...any) {
	if d.Out != nil {
		d.Out(format, args...)
	}
}

func nativeMacMigrationDeps(env cli.Env, home string) macMigrationDeps {
	return macMigrationDeps{
		Registered: func(ctx context.Context) ([]layout.ConnectorInstance, error) {
			return macRegisteredInstancesIn(ctx, runner, os.Geteuid(), layout.MacLegacy)
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macMigrationService, error) {
			legacy, err := layout.MacRuntimeIn(layout.MacLegacy, home)
			if err != nil {
				return nil, err
			}
			if kind != launchd.Connector {
				return macService(legacy, home, kind)
			}
			return launchd.New(launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
				ExecutablePath: legacy.ExecutablePath, CredentialsDirectory: inst.DirUnder(legacy.ConnectorRoot), StateDirectory: inst.DirUnder(legacy.StateRoot),
				Instance: inst, Namespace: layout.MacLegacy})
		},
		MigrateKeys: devicekeys.MigrateLegacy,
		Out:         func(format string, args ...any) { printf(env.Stdout, format, args...) },
	}
}

// refuseUnmovedMacLegacy keeps commands other than up and reset from
// treating a legacy-only host as a fresh one.
func refuseUnmovedMacLegacy(home string) error {
	current, err := layout.MacRuntime(home)
	if err != nil {
		return err
	}
	legacy, err := layout.MacRuntimeIn(layout.MacLegacy, home)
	if err != nil {
		return err
	}
	old, err := fsx.Lstat(legacy.AppRoot)
	if err != nil {
		return errors.New("macOS installation directories could not be inspected")
	}
	cur, err := fsx.Lstat(current.AppRoot)
	if err != nil {
		return errors.New("macOS installation directories could not be inspected")
	}
	if old.Exists && !cur.Exists {
		return fmt.Errorf("an installation from before the rename is at %s; run edge-setup up to move it to %s", legacy.AppRoot, current.AppRoot)
	}
	return nil
}

// migrateMacLegacyNamespace runs under the current namespace's setup lock.
func migrateMacLegacyNamespace(ctx context.Context, home string, deps macMigrationDeps) error {
	current, err := layout.MacRuntime(home)
	if err != nil {
		return err
	}
	legacy, err := layout.MacRuntimeIn(layout.MacLegacy, home)
	if err != nil {
		return err
	}
	if deps.Registered == nil || deps.Service == nil || deps.MigrateKeys == nil || len(deps.Self) == 0 {
		return errors.New("macOS namespace migration dependencies are missing")
	}
	old, err := inspectMacMigrationDir(legacy.AppRoot)
	if err != nil {
		return err
	}
	// A marker means an earlier run moved the directory and stopped before
	// the remaining steps. Without either, the host never ran a legacy
	// release: its keychain is not queried and nothing below runs.
	pending, err := fsx.Lstat(filepath.Join(current.AppRoot, macNamespaceMarker))
	if err != nil {
		return errors.New("migration marker could not be inspected")
	}
	if !old && !pending.Exists {
		return nil
	}
	if old {
		if err := moveMacLegacyRoot(ctx, home, current, legacy, deps); err != nil {
			return err
		}
	}
	// Everything after the rename is keyed on the marker, not on the legacy
	// root, and is idempotent: a run interrupted after the rename resumes
	// here and finishes the cleanup before up removes the marker.
	// The running release goes first, before the aliases are retargeted and
	// before any step that can fail: from then on the aliases run this
	// release, which resumes here, never the pre-rename one, which would
	// recreate the legacy namespace.
	if _, err := installMacBinaryAfterMove(current, deps.Self); err != nil {
		return errors.New("running release could not be installed in the moved installation")
	}
	if err := removeMacLegacyPlists(home); err != nil {
		return err
	}
	if err := retargetMacInstallerAliases(home, legacy, current); err != nil {
		return err
	}
	moved, err := deps.MigrateKeys(ctx)
	if err != nil {
		return err
	}
	if len(moved) > 0 {
		deps.printf("moved %d device key(s) to the current keychain name", len(moved))
	}
	if err := moveMacLegacyLogs(home); err != nil {
		return err
	}
	if err := rebuildMacMovedEnvironments(current, legacy, deps); err != nil {
		return err
	}
	return removeMacLegacyLock(legacy)
}

func inspectMacMigrationDir(path string) (bool, error) {
	info, err := fsx.Lstat(path)
	if err != nil {
		return false, errors.New("macOS installation directory could not be inspected")
	}
	if info.Exists && (!info.Dir || info.Symlink || info.Owner != fsx.Current()) {
		return false, fmt.Errorf("%s is not a directory owned by this user; nothing was moved", path)
	}
	return info.Exists, nil
}

func moveMacLegacyRoot(ctx context.Context, home string, current, legacy layout.MacRuntimePaths, deps macMigrationDeps) error {
	entries, err := os.ReadDir(legacy.AppRoot)
	if err != nil {
		return errors.New("legacy macOS installation directory could not be listed; nothing was moved")
	}
	if len(entries) == 0 {
		// Nothing to move; an empty directory is not an installation.
		if err := os.Remove(legacy.AppRoot); err != nil {
			return errors.New("empty legacy macOS installation directory could not be removed")
		}
		return nil
	}
	present, err := inspectMacMigrationDir(current.AppRoot)
	if err != nil {
		return err
	}
	if present {
		entries, err := os.ReadDir(current.AppRoot)
		if err != nil {
			return errors.New("current macOS installation directory could not be listed; nothing was moved")
		}
		if len(entries) > 0 {
			return fmt.Errorf("both %s (from before the rename) and %s exist; nothing was moved. Keep one: move the other aside, or remove both with edge-setup reset", legacy.AppRoot, current.AppRoot)
		}
		// An empty directory holds nothing: the legacy one takes its place.
		if err := os.Remove(current.AppRoot); err != nil {
			return errors.New("empty current macOS installation directory could not be replaced; nothing was moved")
		}
	}
	unlock, err := lockMacRuntime(legacy)
	if err != nil {
		return errors.New("an edge-setup from before the rename is running; let it finish, then run up again")
	}
	defer unlock()
	for _, name := range []string{"upgrade-journal.json", "upgrade-recovery"} {
		info, err := fsx.Lstat(filepath.Join(legacy.AppRoot, name))
		if err != nil || info.Exists {
			return errors.New("an interrupted upgrade from before the rename must be recovered first: run its upgrade command again; nothing was moved")
		}
	}
	registered, err := deps.Registered(ctx)
	if err != nil {
		return errors.New("legacy LaunchAgent inventory could not be verified; nothing was moved")
	}
	instances, err := macResetInstances(home, legacy, registered)
	if err != nil {
		return fmt.Errorf("legacy installation inventory: %v; nothing was moved", err)
	}
	type job struct {
		kind    launchd.Kind
		inst    layout.ConnectorInstance
		service macMigrationService
		status  launchd.Status
	}
	jobs := make([]job, 0, len(instances)+2)
	for _, inst := range instances {
		jobs = append(jobs, job{kind: launchd.Connector, inst: inst})
	}
	jobs = append(jobs, job{kind: launchd.Operator, inst: layout.DefaultConnectorInstance}, job{kind: launchd.Gateway, inst: layout.DefaultConnectorInstance})
	// Read every job before touching any: the restart inventory is made
	// durable before the first stop, so a crash cannot lose it.
	markerPath := filepath.Join(legacy.AppRoot, macNamespaceMarker)
	marker, err := readMacNamespaceMarker(markerPath)
	if err != nil {
		return err
	}
	if marker == nil {
		marker = &macNamespaceMarkerFile{Restart: []layout.ConnectorInstance{}}
	}
	for i := range jobs {
		service, err := deps.Service(jobs[i].kind, jobs[i].inst)
		if err != nil {
			return errors.New("legacy LaunchAgent could not be addressed; nothing was moved")
		}
		status, err := service.Status(ctx)
		if err != nil {
			return errors.New("legacy LaunchAgent state is unknown; nothing was moved")
		}
		jobs[i].service, jobs[i].status = service, status
		if status.Registered && jobs[i].kind == launchd.Connector && !slices.Contains(marker.Restart, jobs[i].inst) {
			// Registered, not only running: launchd may be throttling a
			// connector after a crash. A resumed run only adds: a connector
			// an earlier run stopped is no longer registered but stays.
			marker.Restart = append(marker.Restart, jobs[i].inst)
		}
	}
	if err := writeMacNamespaceMarker(markerPath, *marker); err != nil {
		return errors.New("migration marker could not be written; nothing was moved")
	}
	var stopped []macMigrationService
	restore := func() {
		// Best effort: put back the jobs this run stopped, from their
		// untouched plists, so a refused move leaves the host as found.
		for _, service := range stopped {
			if present, _ := fsx.RequireRegular(service.PlistPath(), 0o600, fsx.Current()); present {
				_ = service.StartInstalled(context.Background())
			}
		}
	}
	for _, j := range jobs {
		if !j.status.Registered {
			continue
		}
		if err := j.service.Stop(ctx); err != nil {
			restore()
			return errors.New("legacy LaunchAgent could not be stopped; nothing was moved")
		}
		stopped = append(stopped, j.service)
		if status, err := j.service.Status(ctx); err != nil || status.Registered {
			restore()
			return errors.New("legacy LaunchAgent stop was not proved; nothing was moved")
		}
	}
	// Both roots sit under ~/Library/Application Support: one volume, so the
	// rename is atomic. It fails rather than copies if that ever changes.
	// The marker moves with the directory and drives the remaining steps.
	if err := os.Rename(legacy.AppRoot, current.AppRoot); err != nil {
		restore()
		return fmt.Errorf("%s could not be renamed to %s (%v); the previous installation was restarted", legacy.AppRoot, current.AppRoot, err)
	}
	deps.printf("moved %s to %s", legacy.AppRoot, current.AppRoot)
	return nil
}

// removeMacLegacyPlists drops the legacy job definitions: they point into
// the old root and would fail at the next login. up renders current ones.
func removeMacLegacyPlists(home string) error {
	dir := filepath.Join(home, "Library", "LaunchAgents")
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return errors.New("legacy LaunchAgents could not be listed")
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), layout.MacLegacy.LabelPrefix) || !strings.HasSuffix(entry.Name(), ".plist") {
			continue
		}
		if err := removePrivateUnlinkFile(filepath.Join(dir, entry.Name()), fsx.Current()); err != nil {
			return fmt.Errorf("legacy LaunchAgent %s could not be removed", entry.Name())
		}
	}
	return nil
}

func readMacNamespaceMarker(path string) (*macNamespaceMarkerFile, error) {
	data, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("migration marker could not be read")
	}
	var marker macNamespaceMarkerFile
	if err := decodeMacUpgradeJSON(data, &marker); err != nil {
		return nil, errors.New("migration marker is invalid")
	}
	for _, inst := range marker.Restart {
		if _, err := layout.ParseConnectorInstance(string(inst)); err != nil {
			return nil, errors.New("migration marker names an invalid connector")
		}
	}
	if marker.Restart == nil {
		marker.Restart = []layout.ConnectorInstance{}
	}
	return &marker, nil
}

func writeMacNamespaceMarker(path string, marker macNamespaceMarkerFile) error {
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, data, 0o600, fsx.Current())
}

// retargetMacInstallerAliases points the edge-setup links that named the
// legacy binary at the moved one. The link inside bin/ moved with the
// directory; the ones in ~/.local/bin did not. Other links are left alone.
func retargetMacInstallerAliases(home string, legacy, current layout.MacRuntimePaths) error {
	for _, path := range macInstallerAliasPaths(home, current) {
		owned, err := macInstallerAliasOwned(path, legacy.ExecutablePath)
		if err != nil {
			return err
		}
		if !owned {
			continue
		}
		tmp := path + ".edge-setup-rename"
		_ = os.Remove(tmp)
		if err := os.Symlink(current.ExecutablePath, tmp); err != nil {
			return errors.New("installer alias could not be pointed at the moved binary")
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(tmp)
			return errors.New("installer alias could not be pointed at the moved binary")
		}
	}
	return nil
}

// moveMacLegacyLogs renames the legacy job logs to their current labels.
// A log already present under its current name is kept and the legacy one
// left for reset.
func moveMacLegacyLogs(home string) error {
	from, to := layout.MacLegacy.LogsIn(home), layout.MacCurrent.LogsIn(home)
	entries, err := os.ReadDir(from)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("legacy log directory could not be listed")
	}
	if err := fsx.EnsureDir(to, 0o700, fsx.Current()); err != nil {
		return errors.New("current log directory could not be prepared")
	}
	for _, entry := range entries {
		name, ok := strings.CutPrefix(entry.Name(), layout.MacLegacy.LabelPrefix)
		if !ok || !entry.Type().IsRegular() {
			continue
		}
		target := filepath.Join(to, layout.MacCurrent.LabelPrefix+name)
		if info, err := fsx.Lstat(target); err != nil || info.Exists {
			continue
		}
		if err := os.Rename(filepath.Join(from, entry.Name()), target); err != nil {
			return errors.New("legacy log could not be moved")
		}
	}
	if entries, err := os.ReadDir(from); err == nil && len(entries) == 0 {
		_ = os.Remove(from)
	}
	return nil
}

// rebuildMacMovedEnvironments removes what embeds the old absolute path
// and cannot run from the new one: the Hermes virtual environments and the
// uv-managed Python. They hold no user data; up rebuilds them from the
// pinned, locked sources. Runtime data, credentials and the checkout stay.
func rebuildMacMovedEnvironments(current, legacy layout.MacRuntimePaths, deps macMigrationDeps) error {
	path := filepath.Join(current.AppRoot, macNamespaceMarker)
	marker, err := readMacNamespaceMarker(path)
	if err != nil || marker == nil || marker.Rebuilt {
		return err
	}
	stale := []string{filepath.Join(current.AppRoot, "python"), filepath.Join(current.AppRoot, "python-bin")}
	venvs, err := filepath.Glob(filepath.Join(current.AppRoot, "releases", "*", "hermes-agent", "venv"))
	if err != nil {
		return errors.New("moved environments could not be listed")
	}
	stale = append(stale, venvs...)
	for _, dir := range stale {
		if err := removeMacMovedDir(current.AppRoot, dir); err != nil {
			return err
		}
	}
	marker.Rebuilt = true
	if err := writeMacNamespaceMarker(path, *marker); err != nil {
		return errors.New("migration marker could not be updated")
	}
	deps.printf("path-bound Python environments from %s will be rebuilt", legacy.AppRoot)
	return nil
}

func removeMacMovedDir(root, dir string) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("moved environment is outside the installation")
	}
	info, err := fsx.Lstat(dir)
	if err != nil {
		return errors.New("moved environment could not be inspected")
	}
	if !info.Exists {
		return nil
	}
	if !info.Dir || info.Symlink || info.Owner != fsx.Current() {
		return fmt.Errorf("%s is not a directory owned by this user; it was left in place", dir)
	}
	// RemoveAll unlinks symlinks; it never follows them out of the root.
	if err := os.RemoveAll(dir); err != nil {
		return errors.New("moved environment could not be removed for rebuild")
	}
	return nil
}

// macRestartService is one connector's job under its current label.
type macRestartService interface {
	Status(context.Context) (launchd.Status, error)
	Start(context.Context) error
}

// macMigrationPending reports whether a moved installation awaits the end
// of up (its marker is still present).
func macMigrationPending(p layout.MacRuntimePaths) (bool, error) {
	info, err := fsx.Lstat(filepath.Join(p.AppRoot, macNamespaceMarker))
	if err != nil {
		return false, errors.New("migration marker could not be inspected")
	}
	return info.Exists, nil
}

// installMacBinaryAfterMove installs the running release under the current
// root while a migration is pending. It rewrites the binary only when it
// differs, so a resumed run reinstalls it if an earlier one did not.
func installMacBinaryAfterMove(p layout.MacRuntimePaths, self []byte) (bool, error) {
	info, err := fsx.Lstat(filepath.Join(p.AppRoot, macNamespaceMarker))
	if err != nil {
		return false, errors.New("migration marker could not be inspected")
	}
	if !info.Exists {
		return false, nil
	}
	return installMacBinary(self, p.ExecutablePath)
}

// finishMacNamespaceMigration restarts the connectors that ran under their
// legacy labels, once up has rendered their current definitions, then drops
// the marker. A refused or unlinked connector is not started, and one
// already registered (an interrupted earlier completion started it) is left
// alone: bootstrapping a registered job fails, which would block the rest.
func finishMacNamespaceMigration(ctx context.Context, p layout.MacRuntimePaths, service func(layout.ConnectorInstance) (macRestartService, error)) error {
	path := filepath.Join(p.AppRoot, macNamespaceMarker)
	marker, err := readMacNamespaceMarker(path)
	if err != nil || marker == nil {
		return err
	}
	if !marker.Rebuilt {
		return errors.New("migration marker is invalid")
	}
	for _, inst := range marker.Restart {
		if !fsx.Exists(filepath.Join(inst.DirUnder(p.ConnectorRoot), "link.json")) || fsx.Exists(filepath.Join(inst.DirUnder(p.StateRoot), linkRefusedMarker)) {
			continue
		}
		s, err := service(inst)
		if err != nil {
			return fmt.Errorf("connector %s could not be addressed under its current name", inst.Label())
		}
		status, err := s.Status(ctx)
		if err != nil {
			return fmt.Errorf("connector %s state is unknown under its current name", inst.Label())
		}
		if status.Registered {
			continue
		}
		if err := s.Start(ctx); err != nil {
			return fmt.Errorf("connector %s could not be started under its current name", inst.Label())
		}
	}
	return removePrivateUnlinkFile(path, fsx.Current())
}
