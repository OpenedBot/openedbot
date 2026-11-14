package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

type macResetService interface {
	Stop(context.Context) error
	Status(context.Context) (launchd.Status, error)
	PlistPath() string
	Label() string
}

type macResetDeps struct {
	Keys       devicekeys.ResetStore
	Registered func(context.Context) ([]layout.ConnectorInstance, error)
	Service    func(launchd.Kind, layout.ConnectorInstance) (macResetService, error)
	Out        func(string, ...any)
}

func validateMacResetOptions(o reset.Options) error {
	if o.PurgePackages || o.Legacy || o.PurgeTailscale || o.RemoveAdmin || o.RestoreCloudUser {
		return errors.New("the Linux package, account and legacy reset flags are unavailable on macOS")
	}
	if o.PurgeData && !o.DataLossAccepted {
		return errors.New("--purge-data destroys runtime credentials and workspaces; add --i-understand-data-loss")
	}
	return nil
}

// runMacReset serves reset and uninstall on macOS; verb names the command.
// An installation left by a release from before the product rename is reset
// first, with the same proofs, so neither namespace survives the command.
func runMacReset(env cli.Env, o reset.Options, yes bool, verb string) int {
	if err := validateMacResetOptions(o); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	if !yes && !o.Plan {
		return fail(env, cli.ExitRefused, "%s removes the user installation and device keys; add --yes (or --plan to preview)", verb)
	}
	if code := prepareConnectorHostAllowingLegacy(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home could not be resolved")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS reset paths could not be resolved")
	}
	legacy, err := layout.MacRuntimeIn(layout.MacLegacy, home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS reset paths could not be resolved")
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 2*time.Minute)
	defer stop()
	legacyDeps, err := nativeMacResetDeps(env, home, legacy)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	legacyPresent, err := macNamespacePresent(ctx, home, legacy, legacyDeps)
	if err != nil {
		return fail(env, cli.ExitFailure, "%s: %v", verb, err)
	}
	if legacyPresent {
		if o.Plan {
			printf(env.Stdout, "installation from before the rename:")
		}
		if err := resetMacRuntime(ctx, home, legacy, o, legacyDeps); err != nil {
			return fail(env, cli.ExitFailure, "%s of the installation from before the rename: %v", verb, err)
		}
		if !o.Plan {
			if err := removeMacLegacyLock(legacy); err != nil {
				return fail(env, cli.ExitFailure, "%s: %v", verb, err)
			}
		}
	}
	deps, err := nativeMacResetDeps(env, home, p)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if o.Plan && legacyPresent {
		printf(env.Stdout, "current installation:")
	}
	if err := resetMacRuntime(ctx, home, p, o, deps); err != nil {
		return fail(env, cli.ExitFailure, "%s: %v", verb, err)
	}
	if !o.Plan {
		printf(env.Stdout, "%s complete: openedbot user services, installation and device keys removed", verb)
		if !o.PurgeData {
			printf(env.Stdout, "runtime data retained at %s", p.RuntimeRoot)
			if legacyPresent && fsx.Exists(legacy.RuntimeRoot) {
				printf(env.Stdout, "runtime data from before the rename retained at %s", legacy.RuntimeRoot)
			}
		}
	}
	return cli.ExitOK
}

func nativeMacResetDeps(env cli.Env, home string, p layout.MacRuntimePaths) (macResetDeps, error) {
	var keys devicekeys.ResetStore
	var err error
	if p.Namespace.IsLegacy() {
		keys, err = devicekeys.NewLegacyResetStore()
	} else {
		keys, err = devicekeys.NewResetStore()
	}
	if err != nil {
		return macResetDeps{}, errors.New("macOS reset key storage could not be inspected")
	}
	return macResetDeps{Keys: keys,
		Registered: func(ctx context.Context) ([]layout.ConnectorInstance, error) {
			return macRegisteredInstancesIn(ctx, runner, os.Geteuid(), p.Namespace)
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macResetService, error) {
			if kind != launchd.Connector {
				return macService(p, home, kind)
			}
			return launchd.New(launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
				ExecutablePath: p.ExecutablePath, CredentialsDirectory: inst.DirUnder(p.ConnectorRoot), StateDirectory: inst.DirUnder(p.StateRoot), Instance: inst, Namespace: p.Namespace})
		},
		Out: func(format string, args ...any) { printf(env.Stdout, format, args...) },
	}, nil
}

// macNamespacePresent reports whether any trace of one namespace remains:
// its directory, logs, plists, registered jobs or keychain items.
func macNamespacePresent(ctx context.Context, home string, p layout.MacRuntimePaths, deps macResetDeps) (bool, error) {
	for _, path := range []string{p.AppRoot, p.Namespace.LogsIn(home)} {
		info, err := fsx.Lstat(path)
		if err != nil {
			return false, errors.New("macOS installation directories could not be inspected")
		}
		if info.Exists {
			return true, nil
		}
	}
	entries, err := os.ReadDir(filepath.Join(home, "Library", "LaunchAgents"))
	if err != nil && !os.IsNotExist(err) {
		return false, errors.New("macOS LaunchAgents could not be listed")
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), p.Namespace.LabelPrefix) {
			return true, nil
		}
	}
	registered, err := deps.Registered(ctx)
	if err != nil {
		return false, errors.New("macOS LaunchAgent inventory could not be verified")
	}
	if len(registered) > 0 {
		return true, nil
	}
	// The connector inventory leaves out the fixed gateway and operator
	// labels: ask launchd about those two directly.
	for _, kind := range []launchd.Kind{launchd.Gateway, launchd.Operator} {
		service, err := deps.Service(kind, layout.DefaultConnectorInstance)
		if err != nil {
			return false, errors.New("macOS LaunchAgent could not be addressed")
		}
		status, err := service.Status(ctx)
		if err != nil {
			return false, errors.New("macOS LaunchAgent state is unknown")
		}
		if status.Registered {
			return true, nil
		}
	}
	keys, err := deps.Keys.Instances(ctx)
	if err != nil {
		return false, errors.New("macOS device key inventory could not be verified")
	}
	return len(keys) > 0, nil
}

// removeMacLegacyLock drops the pre-rename lock and its directory once the
// installation it coordinated is gone. Retained runtime data keeps both.
func removeMacLegacyLock(p layout.MacRuntimePaths) error {
	if !p.Namespace.IsLegacy() {
		return errors.New("only the legacy coordination lock is removable")
	}
	if info, err := fsx.Lstat(p.AppRoot); err != nil || info.Exists {
		if err != nil {
			return errors.New("legacy installation residue is unknown")
		}
		return nil
	}
	lock := macSetupLockPath(p)
	if err := removePrivateUnlinkFile(lock, fsx.Current()); err != nil {
		return errors.New("legacy coordination lock could not be removed")
	}
	parent := filepath.Dir(lock)
	entries, err := os.ReadDir(parent)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("legacy installation directory could not be listed")
	}
	if len(entries) == 0 {
		if err := os.Remove(parent); err != nil {
			return errors.New("empty legacy installation directory could not be removed")
		}
	}
	return nil
}

func resetMacRuntime(ctx context.Context, home string, p layout.MacRuntimePaths, o reset.Options, deps macResetDeps) error {
	if err := validateMacResetOptions(o); err != nil {
		return err
	}
	want, err := layout.MacRuntimeIn(p.Namespace, home)
	if err != nil || p != want || deps.Keys == nil || deps.Registered == nil || deps.Service == nil {
		return errors.New("macOS reset configuration is invalid")
	}
	if err := ctx.Err(); err != nil {
		return errors.New("macOS reset was interrupted before inspection")
	}
	if err := inspectMacResetRoots(home, p); err != nil {
		return err
	}
	if err := inspectMacInstallerAliases(home, p); err != nil {
		return err
	}
	if !o.Plan {
		unlock, err := lockMacRuntime(p)
		if err != nil {
			return errors.New("macOS setup is busy or its lock could not be verified")
		}
		defer unlock()
	}
	registered, err := deps.Registered(ctx)
	if err != nil {
		return errors.New("macOS reset LaunchAgent inventory could not be verified")
	}
	keyInstances, err := deps.Keys.Instances(ctx)
	if err != nil {
		return errors.New("macOS reset device key inventory could not be verified")
	}
	instances, err := macResetInstances(home, p, registered, keyInstances)
	if err != nil {
		return err
	}
	services := make([]macResetService, 0, len(instances)+2)
	addService := func(kind launchd.Kind, inst layout.ConnectorInstance) error {
		service, err := deps.Service(kind, inst)
		label := p.Namespace.LabelPrefix + string(kind)
		if kind == launchd.Connector {
			label = p.Namespace.LabelPrefix + "connector." + inst.Label()
		}
		plist := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
		if err != nil || service == nil || service.Label() != label || service.PlistPath() != plist {
			return errors.New("macOS reset service is outside the managed namespace")
		}
		if _, err := fsx.RequireRegular(plist, 0o600, fsx.Current()); err != nil {
			return errors.New("macOS reset plist is not private and user-owned")
		}
		for _, suffix := range []string{".out.log", ".err.log"} {
			if err := inspectMacResetLog(filepath.Join(p.Namespace.LogsIn(home), label+suffix)); err != nil {
				return err
			}
		}
		if _, err := service.Status(ctx); err != nil {
			return errors.New("macOS reset service status is unknown")
		}
		services = append(services, service)
		return nil
	}
	for _, inst := range instances {
		if err := addService(launchd.Connector, inst); err != nil {
			return err
		}
	}
	for _, kind := range []launchd.Kind{launchd.Operator, launchd.Gateway} {
		if err := addService(kind, layout.DefaultConnectorInstance); err != nil {
			return err
		}
	}
	if o.Plan {
		if deps.Out != nil {
			for _, line := range macResetPlan(p, o) {
				deps.Out("%s", line)
			}
		}
		return nil
	}
	for _, service := range services {
		if err := service.Stop(ctx); err != nil {
			return errors.New("macOS reset service stop failed; device keys and runtime files were preserved")
		}
		status, err := service.Status(ctx)
		if err != nil || status.Registered || status.Running {
			return errors.New("macOS reset service stop was not proved; device keys and runtime files were preserved")
		}
	}
	for _, inst := range keyInstances {
		if err := deps.Keys.Remove(ctx, inst); err != nil {
			return errors.New("macOS reset device key removal could not be verified; runtime files were preserved")
		}
	}
	remainingKeys, err := deps.Keys.Instances(ctx)
	if err != nil || len(remainingKeys) != 0 {
		return errors.New("macOS reset device keys remain or their absence is unknown; runtime files were preserved")
	}
	if err := inspectMacResetRoots(home, p); err != nil {
		return err
	}
	for _, service := range services {
		if err := removePrivateUnlinkFile(service.PlistPath(), fsx.Current()); err != nil {
			return errors.New("macOS reset plist removal could not be verified")
		}
		for _, suffix := range []string{".out.log", ".err.log"} {
			log := filepath.Join(p.Namespace.LogsIn(home), service.Label()+suffix)
			if err := inspectMacResetLog(log); err != nil {
				return err
			}
			if err := fsx.Remove(log); err != nil {
				return errors.New("macOS reset log could not be removed")
			}
			if info, err := fsx.Lstat(log); err != nil || info.Exists {
				return errors.New("macOS reset log removal could not be verified")
			}
		}
	}
	if err := removeMacInstallerAliases(home, p); err != nil {
		return err
	}
	if err := removeMacResetInstallation(ctx, p, o.PurgeData); err != nil {
		return err
	}
	logRoot := p.Namespace.LogsIn(home)
	logEntries, err := os.ReadDir(logRoot)
	if err != nil && !os.IsNotExist(err) {
		return errors.New("macOS reset log directory residue is unknown")
	}
	if err == nil && len(logEntries) == 0 {
		if err := os.Remove(logRoot); err != nil {
			return errors.New("macOS reset empty log directory could not be removed")
		}
	}
	remainingKeys, err = deps.Keys.Instances(ctx)
	if err != nil || len(remainingKeys) != 0 {
		return errors.New("macOS reset device key residue is present or unknown")
	}
	remainingJobs, err := deps.Registered(ctx)
	if err != nil || len(remainingJobs) != 0 {
		return errors.New("macOS reset connector residue is present or unknown")
	}
	for _, service := range services {
		status, err := service.Status(ctx)
		if err != nil || status.Registered || status.Running {
			return errors.New("macOS reset service residue is present or unknown")
		}
	}
	return nil
}

func inspectMacResetRoots(home string, p layout.MacRuntimePaths) error {
	paths := []string{home, filepath.Join(home, "Library"), filepath.Join(home, "Library", "Application Support"),
		filepath.Dir(p.AppRoot), p.AppRoot, p.RuntimeRoot, p.ConnectorRoot, p.StateRoot,
		filepath.Join(home, "Library", "LaunchAgents"), filepath.Join(home, "Library", "Logs"), p.Namespace.LogsIn(home)}
	for _, path := range paths {
		info, err := fsx.Lstat(path)
		if err != nil || (info.Exists && (!info.Dir || info.Symlink || info.Owner != fsx.Current() || info.Mode&0o022 != 0)) {
			return errors.New("macOS reset directory is unsafe or belongs to another user")
		}
		private := path == p.AppRoot || path == p.RuntimeRoot || path == p.ConnectorRoot || path == p.StateRoot || path == p.Namespace.LogsIn(home)
		if info.Exists && private && info.Mode != 0o700 {
			return errors.New("macOS reset managed directory is not private")
		}
	}
	return nil
}

func inspectMacResetLog(path string) error {
	info, err := fsx.Lstat(path)
	if err != nil || (info.Exists && (!info.Regular || info.Symlink || info.Owner != fsx.Current() || info.Mode&0o022 != 0)) {
		return errors.New("macOS reset log is unsafe or belongs to another user")
	}
	return nil
}

func macResetInstances(home string, p layout.MacRuntimePaths, groups ...[]layout.ConnectorInstance) ([]layout.ConnectorInstance, error) {
	seen := map[layout.ConnectorInstance]bool{layout.DefaultConnectorInstance: true}
	add := func(inst layout.ConnectorInstance) error {
		if _, err := layout.ParseConnectorInstance(string(inst)); err != nil || len(seen) >= 256 && !seen[inst] {
			return errors.New("macOS reset connector inventory is invalid or too large")
		}
		seen[inst] = true
		return nil
	}
	for _, group := range groups {
		for _, inst := range group {
			if err := add(inst); err != nil {
				return nil, err
			}
		}
	}
	for _, root := range []string{p.ConnectorRoot, p.StateRoot} {
		entries, err := os.ReadDir(root)
		if err != nil && !os.IsNotExist(err) {
			return nil, errors.New("macOS reset connector directories could not be listed")
		}
		for _, entry := range entries {
			if entry.IsDir() {
				if inst, err := layout.ParseConnectorInstance(entry.Name()); err == nil {
					if err := add(inst); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	entries, err := os.ReadDir(filepath.Join(home, "Library", "LaunchAgents"))
	if err != nil && !os.IsNotExist(err) {
		return nil, errors.New("macOS reset plists could not be listed")
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, p.Namespace.LabelPrefix) {
			continue
		}
		if name == p.Namespace.LabelPrefix+"gateway.plist" || name == p.Namespace.LabelPrefix+"operator.plist" {
			continue
		}
		name, ok := strings.CutPrefix(strings.TrimSuffix(name, ".plist"), p.Namespace.LabelPrefix+"connector.")
		if !ok || !strings.HasSuffix(entry.Name(), ".plist") {
			return nil, errors.New("macOS reset found an unknown plist in its namespace")
		}
		if name == "default" {
			name = ""
		}
		inst, err := layout.ParseConnectorInstance(name)
		if err != nil || entry.Name() != p.Namespace.LabelPrefix+"connector."+inst.Label()+".plist" {
			return nil, errors.New("macOS reset found an invalid connector plist")
		}
		if err := add(inst); err != nil {
			return nil, err
		}
	}
	entries, err = os.ReadDir(p.Namespace.LogsIn(home))
	if err != nil && !os.IsNotExist(err) {
		return nil, errors.New("macOS reset logs could not be listed")
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, p.Namespace.LabelPrefix) {
			continue
		}
		label := ""
		switch {
		case strings.HasSuffix(name, ".out.log"):
			label = strings.TrimSuffix(name, ".out.log")
		case strings.HasSuffix(name, ".err.log"):
			label = strings.TrimSuffix(name, ".err.log")
		default:
			return nil, errors.New("macOS reset found an unknown log in its namespace")
		}
		if label == p.Namespace.LabelPrefix+"gateway" || label == p.Namespace.LabelPrefix+"operator" {
			continue
		}
		name, ok := strings.CutPrefix(label, p.Namespace.LabelPrefix+"connector.")
		if !ok {
			return nil, errors.New("macOS reset found an unknown service log in its namespace")
		}
		if name == "default" {
			name = ""
		}
		inst, err := layout.ParseConnectorInstance(name)
		if err != nil || label != p.Namespace.LabelPrefix+"connector."+inst.Label() {
			return nil, errors.New("macOS reset found an invalid connector log")
		}
		if err := add(inst); err != nil {
			return nil, err
		}
	}
	out := make([]layout.ConnectorInstance, 0, len(seen))
	for inst := range seen {
		for _, root := range []string{p.ConnectorRoot, p.StateRoot} {
			if err := inspectUnlinkDirectory(root, inst.DirUnder(root), fsx.Current()); err != nil {
				return nil, errors.New("macOS reset connector directory is unsafe or belongs to another user")
			}
		}
		out = append(out, inst)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func removeMacResetInstallation(ctx context.Context, p layout.MacRuntimePaths, purge bool) error {
	entries, err := os.ReadDir(p.AppRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("macOS reset installation could not be listed")
	}
	for _, entry := range entries {
		path := filepath.Join(p.AppRoot, entry.Name())
		if !purge && path == p.RuntimeRoot {
			continue
		}
		if err := ctx.Err(); err != nil {
			return errors.New("macOS reset interrupted during installation removal")
		}
		// RemoveAll unlinks symlinks inside the private namespace; it never
		// follows them into personal data outside the managed installation.
		if err := os.RemoveAll(path); err != nil {
			return errors.New("macOS reset installation could not be fully removed")
		}
		if info, err := fsx.Lstat(path); err != nil || info.Exists {
			return errors.New("macOS reset installation removal could not be verified")
		}
	}
	entries, err = os.ReadDir(p.AppRoot)
	if err != nil {
		return errors.New("macOS reset installation residue is unknown")
	}
	if len(entries) == 0 {
		if err := os.Remove(p.AppRoot); err != nil {
			return errors.New("macOS reset installation directory could not be removed")
		}
		if info, err := fsx.Lstat(p.AppRoot); err != nil || info.Exists {
			return errors.New("macOS reset installation directory removal could not be verified")
		}
		return nil
	}
	if !purge && len(entries) == 1 && filepath.Join(p.AppRoot, entries[0].Name()) == p.RuntimeRoot {
		return nil
	}
	return errors.New("macOS reset installation residue remains")
}

func macResetPlan(p layout.MacRuntimePaths, o reset.Options) []string {
	data := "preserve runtime data " + p.RuntimeRoot
	if o.PurgeData {
		data = "PURGE runtime credentials and workspaces " + p.RuntimeRoot
	}
	return []string{
		"+-------------------------------------+",
		"| Inspect Aqua jobs and device keys   |",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Boot out and verify openedbot services    |",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Remove keys, plists and installation|",
		"+------------------+------------------+",
		"                   |",
		"                   v",
		"+------------------+------------------+",
		"| Re-read jobs, keys and path residue |",
		"+-------------------------------------+",
		"remove only the managed namespace " + p.AppRoot,
		data,
		"preserve personal ~/.hermes, its LaunchAgent and other user services",
		"device keys are removed even when runtime data is preserved",
		"retain the private coordination lock " + macSetupLockPath(p),
		"no Cloud runtime deletion or revocation is performed",
	}
}
