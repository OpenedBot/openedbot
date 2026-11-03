package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type macUpgradeOptions struct {
	From, Tag, ReleaseURL, Previous string
	// Version pins the signed release (vX.Y.Z); empty reads LATEST.
	Version                      string
	AllowDowngrade, Finish, Auto bool
}

type macUpgradeKeyReader interface {
	Read(context.Context, layout.ConnectorInstance) ([]byte, error)
}

type macUpgradeService interface {
	macResetService
	Start(context.Context) error
	StartInstalled(context.Context) error
	RenderPlist() ([]byte, error)
}

type macUpgradeDeps struct {
	Keys       macUpgradeKeyReader
	Inventory  devicekeys.Inventory
	Registered func(context.Context) ([]layout.ConnectorInstance, error)
	Service    func(launchd.Kind, layout.ConnectorInstance) (macUpgradeService, error)
	Runner     exec.Runner
	Operator   func(context.Context) error
	Admission  func(context.Context, macUpgradeJob, string, time.Time) error
	Version    string
	// In-process test checkpoints. Native dependencies never install a hook.
	Checkpoint func(string)
}

// Only public identities and fixed local service selectors cross stdin.
// No seed, bearer, enrollment ticket or caller-selected path crosses it.
type macUpgradeKey struct {
	Instance layout.ConnectorInstance `json:"instance"`
	Public   string                   `json:"public_key"`
}

type macUpgradeJob struct {
	Kind     launchd.Kind             `json:"kind"`
	Instance layout.ConnectorInstance `json:"instance"`
	PID      int                      `json:"pid"`
}

type macUpgradeRequest struct {
	SHA256  string          `json:"sha256"`
	Version string          `json:"version"`
	Pin     string          `json:"runtime_pin"`
	NodeBin string          `json:"node_bin"`
	Keys    []macUpgradeKey `json:"keys"`
	Jobs    []macUpgradeJob `json:"jobs"`
}

type macUpgradeResponse struct {
	SHA256  string `json:"sha256"`
	Version string `json:"version"`
	Stage   string `json:"stage"`
}

type macUpgradeSnapshot struct {
	Path    string      `json:"path"`
	Mode    fs.FileMode `json:"mode"`
	Present bool        `json:"present"`
	Data    []byte      `json:"-"`
}

func nativeMacUpgradeDeps(home string, p layout.MacRuntimePaths) (macUpgradeDeps, error) {
	keys, err := devicekeys.New()
	if err != nil {
		return macUpgradeDeps{}, errors.New("macOS device key storage is unavailable")
	}
	inventory, err := devicekeys.NewInventory()
	if err != nil {
		return macUpgradeDeps{}, errors.New("macOS device key inventory is unavailable")
	}
	return macUpgradeDeps{Keys: keys, Inventory: inventory, Runner: runner,
		Registered: func(ctx context.Context) ([]layout.ConnectorInstance, error) {
			return macResetRegisteredInstances(ctx, runner, os.Geteuid())
		},
		Service: func(kind launchd.Kind, inst layout.ConnectorInstance) (macUpgradeService, error) {
			if kind != launchd.Connector {
				return macService(p, home, kind)
			}
			return launchd.New(launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
				ExecutablePath: p.ExecutablePath, CredentialsDirectory: inst.DirUnder(p.ConnectorRoot), StateDirectory: inst.DirUnder(p.StateRoot), Instance: inst})
		},
		Operator: func(ctx context.Context) error { return proveMacOperator(ctx, p.OperatorSocket) },
		Admission: func(ctx context.Context, job macUpgradeJob, version string, since time.Time) error {
			return waitMacUpgradeAdmission(ctx, p, job, version, since)
		},
	}, nil
}

func validateMacUpgradeOptions(o macUpgradeOptions) error {
	if o.Auto || o.Finish || o.Previous != "" {
		return errors.New("macOS upgrade supports the confirmed manual path; Linux timer and --finish flags are unavailable")
	}
	if o.From == "" && o.Tag != "" || o.From != "" && o.Tag == "" || o.From != "" && (o.ReleaseURL != "" || o.Version != "") {
		return errors.New("macOS upgrade requires --from with --tag, or the verified release path")
	}
	return nil
}

func runMacUpgrade(env cli.Env, o macUpgradeOptions) int {
	if err := validateMacUpgradeOptions(o); err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home could not be resolved")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS upgrade paths are invalid")
	}
	self, err := os.Executable()
	if err != nil || filepath.Clean(self) != p.ExecutablePath {
		return fail(env, cli.ExitRefused, "run upgrade from the installed macOS executable: %s", p.ExecutablePath)
	}
	if err := inspectMacUpgradePaths(home, p); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	unlock, err := lockMacRuntime(p)
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS setup is busy or its lock could not be verified")
	}
	defer unlock()
	deps, err := nativeMacUpgradeDeps(home, p)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	deps.Version = env.Version
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 5*time.Minute)
	defer stop()
	if recovered, err := recoverMacUpgrade(ctx, home, p, deps); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	} else if recovered {
		printf(env.Stdout, "interrupted macOS upgrade recovered and verified; run upgrade again to check for a new candidate")
		return cli.ExitOK
	}
	var c candidate
	if o.From != "" {
		tag, err := normalizeHex(o.Tag, "--tag")
		if err != nil {
			return fail(env, cli.ExitUsage, "macOS upgrade tag is invalid")
		}
		data, err := fsx.ReadRegular(macDeployKeyPath(p), 0o600, fsx.Current())
		if err != nil {
			return fail(env, cli.ExitRefused, "macOS deployment key is missing or inaccessible; use deploy-key set")
		}
		key, err := parseDeployKey(string(data))
		clear(data)
		if err != nil {
			return fail(env, cli.ExitRefused, "macOS deployment key is invalid")
		}
		defer clear(key)
		c, err = fileCandidate(o.From, tag, key)
		if err != nil {
			return fail(env, cli.ExitRefused, "macOS uploaded candidate was refused")
		}
	} else {
		c, err = releaseCandidate(ctx, o.ReleaseURL, o.Version)
		if err != nil {
			return fail(env, cli.ExitFailure, "macOS release could not be verified")
		}
	}
	version, err := candidateVersion(ctx, filepath.Dir(p.ExecutablePath), c.data, fsx.Current())
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS candidate version could not be verified")
	}
	var note string
	if o.From != "" {
		note, err = refuseDowngrade(env.Version, version, o.AllowDowngrade)
	} else {
		note, err = checkReleaseCandidate(env.Version, c.version, version, o.AllowDowngrade)
	}
	if err != nil {
		return fail(env, cli.ExitRefused, "macOS upgrade: %v", err)
	}
	if note != "" {
		printf(env.Stderr, "upgrade: %s", note)
	}
	if err := upgradeMacRuntime(ctx, home, p, c, version, deps); err != nil {
		return fail(env, cli.ExitFailure, "upgrade: %v", err)
	}
	printf(env.Stdout, "upgraded edge-setup %s -> %s; installed identity and active openedbot services verified", env.Version, version)
	return cli.ExitOK
}

func inspectMacUpgradePaths(home string, p layout.MacRuntimePaths) error {
	want, err := layout.MacRuntime(home)
	if err != nil || p != want {
		return errors.New("macOS upgrade is outside the managed user runtime")
	}
	if err := inspectMacResetRoots(home, p); err != nil {
		return errors.New("macOS upgrade directory is unsafe or inaccessible")
	}
	bin, err := fsx.Lstat(filepath.Dir(p.ExecutablePath))
	if err != nil || !bin.Exists || !bin.Dir || bin.Symlink || bin.Mode != 0o700 || bin.Owner != fsx.Current() {
		return errors.New("macOS installed binary directory is not private and user-owned")
	}
	present, err := fsx.RequireRegular(p.ExecutablePath, 0o700, fsx.Current())
	if err != nil || !present {
		return errors.New("macOS installed executable is missing or unsafe; run up first")
	}
	return nil
}

func collectMacUpgradeKeys(ctx context.Context, keys macUpgradeKeyReader, inventory devicekeys.Inventory) ([]macUpgradeKey, error) {
	if keys == nil || inventory == nil {
		return nil, errors.New("macOS upgrade key inspection is unavailable")
	}
	instances, err := inventory.Instances(ctx)
	if err != nil || len(instances) > 256 {
		return nil, errors.New("macOS upgrade key inventory is unknown")
	}
	out := make([]macUpgradeKey, 0, len(instances))
	seen := map[layout.ConnectorInstance]bool{}
	for _, inst := range instances {
		if _, err := layout.ParseConnectorInstance(string(inst)); err != nil || seen[inst] {
			return nil, errors.New("macOS upgrade key inventory is ambiguous")
		}
		seen[inst] = true
		seed, err := keys.Read(ctx, inst)
		if err != nil || len(seed) != ed25519.SeedSize {
			clear(seed)
			return nil, errors.New("macOS upgrade device key is inaccessible; identity was preserved")
		}
		private := ed25519.NewKeyFromSeed(seed)
		clear(seed)
		public := hex.EncodeToString(private[ed25519.SeedSize:])
		clear(private)
		out = append(out, macUpgradeKey{Instance: inst, Public: public})
	}
	return out, nil
}

func requireMacUpgradeKeys(ctx context.Context, want []macUpgradeKey, deps macUpgradeDeps) error {
	got, err := collectMacUpgradeKeys(ctx, deps.Keys, deps.Inventory)
	if err != nil || len(got) != len(want) {
		return errors.New("macOS installed executable could not prove the existing key inventory")
	}
	seen := map[layout.ConnectorInstance]string{}
	for _, key := range got {
		seen[key.Instance] = key.Public
	}
	for _, key := range want {
		if subtle.ConstantTimeCompare([]byte(seen[key.Instance]), []byte(key.Public)) != 1 {
			return errors.New("macOS installed executable could not prove the unchanged device identity")
		}
		delete(seen, key.Instance)
	}
	if len(seen) != 0 {
		return errors.New("macOS installed executable key inventory changed")
	}
	return nil
}

func upgradeMacRuntime(ctx context.Context, home string, p layout.MacRuntimePaths, c candidate, version string, deps macUpgradeDeps) error {
	if deps.Service == nil || deps.Registered == nil || deps.Runner == nil || version == "" || deps.Version == "" || c.sum != selfupdate.Digest(c.data) {
		return errors.New("macOS upgrade configuration is invalid")
	}
	if err := inspectMacUpgradePaths(home, p); err != nil {
		return err
	}
	recovery := filepath.Join(p.AppRoot, "upgrade-recovery")
	if info, err := fsx.Lstat(recovery); err != nil || info.Exists {
		return errors.New("a previous macOS upgrade recovery directory exists; preserve it and inspect the interrupted upgrade first")
	}
	if info, err := fsx.Lstat(macUpgradeJournalPath(p)); err != nil || info.Exists {
		return errors.New("a previous macOS upgrade journal exists; recover it before preparing another candidate")
	}
	registered, err := deps.Registered(ctx)
	if err != nil {
		return errors.New("macOS upgrade LaunchAgent inventory is unknown")
	}
	keys, err := collectMacUpgradeKeys(ctx, deps.Keys, deps.Inventory)
	if err != nil {
		return err
	}
	keyInstances := make([]layout.ConnectorInstance, 0, len(keys))
	for _, key := range keys {
		keyInstances = append(keyInstances, key.Instance)
	}
	instances, err := macResetInstances(home, p, registered, keyInstances)
	if err != nil {
		return errors.New("macOS upgrade connector inventory could not be verified")
	}
	request := macUpgradeRequest{SHA256: c.sum, Version: version, Pin: p.InstallDir, NodeBin: p.NodeBin, Keys: keys, Jobs: []macUpgradeJob{}}
	snapshots := []macUpgradeSnapshot{{Path: p.ExecutablePath, Mode: 0o700}, {Path: p.ToolConfig, Mode: 0o600},
		{Path: p.Probe, Mode: 0o600}, {Path: p.OAuthProbe, Mode: 0o600}}
	addJob := func(kind launchd.Kind, inst layout.ConnectorInstance) error {
		service, err := checkedMacUpgradeService(home, deps, kind, inst)
		if err != nil {
			return err
		}
		status, err := service.Status(ctx)
		if err != nil || status.Running && (!status.Registered || status.PID <= 0) {
			return errors.New("macOS upgrade service state is unknown")
		}
		if status.Registered && !status.Running && (status.PID != 0 || status.State != "waiting" && status.State != "not running") {
			return errors.New("macOS upgrade registered service inactivity could not be proved")
		}
		if !status.Running {
			return nil
		}
		present, err := fsx.RequireRegular(service.PlistPath(), 0o600, fsx.Current())
		if err != nil || !present {
			return errors.New("macOS active service has no restorable private plist")
		}
		if kind == launchd.Connector {
			if _, err := fsx.ReadRegular(filepath.Join(inst.DirUnder(p.ConnectorRoot), "link.json"), 0o600, fsx.Current()); err != nil {
				return errors.New("macOS active connector has no private link metadata")
			}
			found := false
			for _, key := range keys {
				if key.Instance == inst {
					found = true
				}
			}
			if !found {
				return errors.New("macOS active connector has no accessible existing device key")
			}
			refused, err := fsx.RequireRegular(filepath.Join(inst.DirUnder(p.StateRoot), linkRefusedMarker), 0o600, fsx.Current())
			if err != nil || refused {
				return errors.New("macOS refused connector was left unchanged")
			}
		}
		request.Jobs = append(request.Jobs, macUpgradeJob{Kind: kind, Instance: inst, PID: status.PID})
		snapshots = append(snapshots, macUpgradeSnapshot{Path: service.PlistPath(), Mode: 0o600})
		return nil
	}
	if err := addJob(launchd.Operator, layout.DefaultConnectorInstance); err != nil {
		return err
	}
	for _, inst := range instances {
		if err := addJob(launchd.Connector, inst); err != nil {
			return err
		}
	}
	for i := range snapshots {
		if err := snapshots[i].read(); err != nil {
			return err
		}
	}
	if !snapshots[0].Present {
		return errors.New("macOS installed executable disappeared before upgrade")
	}
	oldRequest := request
	oldRequest.SHA256, oldRequest.Version = selfupdate.Digest(snapshots[0].Data), deps.Version
	if err := callMacUpgradeImage(ctx, p, oldRequest, "check", deps.Runner); err != nil {
		return errors.New("macOS installed executable cannot prove upgrade preflight; installation was preserved")
	}
	if oldRequest.SHA256 == c.sum {
		if version != deps.Version {
			return errors.New("macOS identical candidate reported a divergent version")
		}
		return nil
	}
	journal, err := newMacUpgradeJournal(snapshots, request, deps.Version)
	if err != nil || writeMacUpgradeJournal(p, journal) != nil {
		return errors.New("macOS upgrade preparation journal could not be proved; installation was preserved")
	}
	macUpgradeCheckpoint(deps, "preparing")
	if err := saveMacUpgradeRecovery(recovery, snapshots, deps); err != nil {
		return errors.New("macOS upgrade recovery copy could not be prepared; installed executable was preserved")
	}
	input, err := json.Marshal(request)
	if err != nil || len(input) > 64<<10 || fsx.WriteAtomic(filepath.Join(recovery, "request.json"), input, 0o600, fsx.Current()) != nil {
		return errors.New("macOS upgrade handoff could not be prepared; installed executable was preserved")
	}
	requestProof, err := fsx.ReadRegular(filepath.Join(recovery, "request.json"), 0o600, fsx.Current())
	if err != nil || !bytes.Equal(input, requestProof) || moveMacUpgradePhase(p, journal, "prepared") != nil {
		return errors.New("macOS upgrade prepared journal did not read back; installation was preserved")
	}
	macUpgradeCheckpoint(deps, "prepared")
	applying := false
	rollback := func(reason string) error {
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if err := moveMacUpgradePhase(p, journal, "rolling_back"); err != nil {
			return errors.New(reason + "; rollback journal could not be proved, recovery retained")
		}
		if err := restoreMacUpgrade(recoveryCtx, home, p, snapshots, request, deps, applying); err != nil {
			return fmt.Errorf("%s; rollback could not be fully proved, recovery copy retained at %s", reason, recovery)
		}
		if err := moveMacUpgradePhase(p, journal, "rolled_back"); err != nil {
			return errors.New(reason + "; previous installation restored but rollback journal could not be proved")
		}
		if err := cleanupMacUpgrade(p, deps); err != nil {
			return errors.New(reason + "; previous installation restored but recovery cleanup failed")
		}
		return errors.New(reason + "; previous installation restored and verified")
	}
	if err := moveMacUpgradePhase(p, journal, "installing"); err != nil {
		return errors.New("macOS upgrade installation journal could not be proved; installation was preserved")
	}
	if err := fsx.WriteAtomic(p.ExecutablePath, c.data, 0o700, fsx.Current()); err != nil {
		return rollback("macOS candidate installation failed")
	}
	macUpgradeCheckpoint(deps, "installed")
	if err := callMacUpgradeImage(ctx, p, request, "check", deps.Runner); err != nil {
		return rollback("macOS candidate identity or compatibility check failed before service restart")
	}
	if err := moveMacUpgradePhase(p, journal, "applying"); err != nil {
		return rollback("macOS upgrade activation journal could not be proved")
	}
	applying = true
	macUpgradeCheckpoint(deps, "applying")
	activatedAt := time.Now()
	if err := callMacUpgradeImage(ctx, p, request, "apply", deps.Runner); err != nil {
		return rollback("macOS candidate service activation failed")
	}
	if err := proveMacUpgradeJobs(ctx, home, request.Jobs, deps, false); err != nil {
		return rollback("macOS candidate service state could not be proved")
	}
	for _, job := range request.Jobs {
		if job.Kind == launchd.Connector && (deps.Admission == nil || deps.Admission(ctx, job, version, activatedAt) != nil) {
			return rollback("macOS upgraded connector was not admitted again by openedbot")
		}
	}
	if err := requireMacUpgradeKeys(ctx, request.Keys, deps); err != nil {
		return rollback("macOS upgraded identity changed or became inaccessible")
	}
	st, err := state.LoadFrom(p.ToolConfig, fsx.Current())
	if err != nil {
		return rollback("macOS setup state could not be read")
	}
	if st != nil {
		st.ToolVersion = version
		if err := st.SaveTo(p.ToolConfig, fsx.Current()); err != nil {
			return rollback("macOS setup state could not be saved")
		}
		proof, err := state.LoadFrom(p.ToolConfig, fsx.Current())
		if err != nil || proof == nil || proof.ToolVersion != version {
			return rollback("macOS setup version did not read back")
		}
	}
	installed, err := fsx.ReadRegular(p.ExecutablePath, 0o700, fsx.Current())
	if err != nil || selfupdate.Digest(installed) != c.sum {
		return rollback("macOS installed digest changed")
	}
	terminal, err := readMacUpgradeCurrent(snapshots)
	if err != nil {
		return rollback("macOS committed file inventory could not be proved")
	}
	journal.Terminal = backupDescription(terminal)
	for _, snapshot := range terminal {
		clear(snapshot.Data)
	}
	if err := moveMacUpgradePhase(p, journal, "committed"); err != nil {
		return rollback("macOS upgrade commit journal could not be proved")
	}
	macUpgradeCheckpoint(deps, "committed")
	if err := cleanupMacUpgrade(p, deps); err != nil {
		return errors.New("macOS upgrade proved but recovery cleanup failed")
	}
	return nil
}

func checkedMacUpgradeService(home string, deps macUpgradeDeps, kind launchd.Kind, inst layout.ConnectorInstance) (macUpgradeService, error) {
	if kind != launchd.Connector && kind != launchd.Operator || kind == launchd.Operator && !inst.IsDefault() {
		return nil, errors.New("macOS upgrade service selector is invalid")
	}
	if _, err := layout.ParseConnectorInstance(string(inst)); err != nil {
		return nil, errors.New("macOS upgrade instance is invalid")
	}
	service, err := deps.Service(kind, inst)
	label := macResetLabelPrefix + string(kind)
	if kind == launchd.Connector {
		label = macResetLabelPrefix + "connector." + inst.Label()
	}
	if err != nil || service == nil || service.Label() != label || service.PlistPath() != filepath.Join(home, "Library", "LaunchAgents", label+".plist") {
		return nil, errors.New("macOS upgrade service is outside the managed namespace")
	}
	if _, err := fsx.RequireRegular(service.PlistPath(), 0o600, fsx.Current()); err != nil {
		return nil, errors.New("macOS upgrade plist is not private and user-owned")
	}
	return service, nil
}

func (s *macUpgradeSnapshot) read() error {
	present, err := fsx.RequireRegular(s.Path, s.Mode, fsx.Current())
	if err != nil {
		return errors.New("macOS upgrade file is unsafe or inaccessible")
	}
	s.Present = present
	if !present {
		return nil
	}
	info, err := fsx.Lstat(s.Path)
	limit := int64(1 << 20)
	if s.Mode == 0o700 {
		limit = selfupdate.MaxBinarySize
	}
	if err != nil || info.Size > limit {
		return errors.New("macOS upgrade file is too large")
	}
	s.Data, err = os.ReadFile(s.Path)
	if err != nil || int64(len(s.Data)) > limit {
		return errors.New("macOS upgrade file could not be copied")
	}
	return nil
}

func saveMacUpgradeRecovery(dir string, snapshots []macUpgradeSnapshot, deps macUpgradeDeps) error {
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err
	}
	for i, s := range snapshots {
		if !s.Present {
			continue
		}
		if err := fsx.WriteAtomic(filepath.Join(dir, fmt.Sprintf("%03d", i)), s.Data, s.Mode, fsx.Current()); err != nil {
			return err
		}
		proof, err := fsx.ReadRegular(filepath.Join(dir, fmt.Sprintf("%03d", i)), s.Mode, fsx.Current())
		if err != nil || !bytes.Equal(proof, s.Data) {
			return errors.New("macOS recovery copy did not read back")
		}
		macUpgradeCheckpoint(deps, "backup_written")
	}
	index, err := json.Marshal(snapshots)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(dir, "index.json"), index, 0o600, fsx.Current())
}

func restoreMacUpgrade(ctx context.Context, home string, p layout.MacRuntimePaths, snapshots []macUpgradeSnapshot, request macUpgradeRequest, deps macUpgradeDeps, applying bool) error {
	// Restore the binary before any daemon can be restarted with its old plist.
	for _, s := range snapshots {
		if s.Present {
			if err := fsx.WriteAtomic(s.Path, s.Data, s.Mode, fsx.Current()); err != nil {
				return err
			}
			got, err := fsx.ReadRegular(s.Path, s.Mode, fsx.Current())
			if err != nil || !bytes.Equal(got, s.Data) {
				return errors.New("macOS rollback file did not read back")
			}
		} else {
			if err := removePrivateUnlinkFile(s.Path, fsx.Current()); err != nil {
				return err
			}
		}
	}
	if applying {
		for _, job := range request.Jobs {
			service, err := checkedMacUpgradeService(home, deps, job.Kind, job.Instance)
			if err != nil {
				return err
			}
			restartedAt := time.Now()
			if err := service.Stop(ctx); err != nil {
				return errors.New("macOS rollback stop failed")
			}
			status, err := service.Status(ctx)
			if err != nil || status.Registered || status.Running {
				return errors.New("macOS rollback stop was not proved")
			}
			if err := service.StartInstalled(ctx); err != nil {
				return errors.New("macOS rollback start failed")
			}
			if err := waitMacUpgradeService(ctx, service); err != nil {
				return err
			}
			if job.Kind == launchd.Connector && (deps.Admission == nil || deps.Admission(ctx, job, deps.Version, restartedAt) != nil) {
				return errors.New("macOS rollback connector admission could not be proved")
			}
		}
	}
	if err := requireMacUpgradeKeys(ctx, request.Keys, deps); err != nil {
		return err
	}
	request.SHA256, request.Version = selfupdate.Digest(snapshots[0].Data), deps.Version
	jobs := request.Jobs
	request.Jobs = []macUpgradeJob{}
	if err := callMacUpgradeImage(ctx, p, request, "check", deps.Runner); err != nil {
		return err
	}
	if applying {
		for _, job := range jobs {
			if job.Kind == launchd.Operator && (deps.Operator == nil || deps.Operator(ctx) != nil) {
				return errors.New("macOS rollback operator proof failed")
			}
		}
	}
	return nil
}

func callMacUpgradeImage(ctx context.Context, p layout.MacRuntimePaths, request macUpgradeRequest, stage string, r exec.Runner) error {
	if stage != "check" && stage != "apply" {
		return errors.New("macOS upgrade stage is invalid")
	}
	data, err := json.Marshal(request)
	if err != nil || len(data) > 64<<10 {
		return errors.New("macOS upgrade request is invalid")
	}
	result, err := r.Run(ctx, exec.Cmd{Path: p.ExecutablePath, Args: []string{"internal", "mac-upgrade-" + stage}, Stdin: data,
		Env: []string{"HOME=" + macHomeFromPaths(p), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "NO_COLOR=1"}, Timeout: 90 * time.Second})
	if err != nil || result.ExitCode != 0 || result.Stderr != "" || len(result.Stdout) > 1024 {
		return errors.New("macOS installed upgrade image failed")
	}
	var response macUpgradeResponse
	if err := decodeMacUpgradeJSON([]byte(result.Stdout), &response); err != nil || response.SHA256 != request.SHA256 || response.Version != request.Version || response.Stage != stage {
		return errors.New("macOS installed upgrade image returned an invalid proof")
	}
	return nil
}

func macHomeFromPaths(p layout.MacRuntimePaths) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(p.AppRoot))))
}

func decodeMacUpgradeJSON(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errors.New("macOS upgrade protocol is invalid")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("macOS upgrade protocol has trailing data")
	}
	return nil
}

func proveMacUpgradeJobs(ctx context.Context, home string, jobs []macUpgradeJob, deps macUpgradeDeps, samePID bool) error {
	for _, job := range jobs {
		service, err := checkedMacUpgradeService(home, deps, job.Kind, job.Instance)
		if err != nil {
			return err
		}
		status, err := service.Status(ctx)
		if err != nil || !status.Registered || !status.Running || status.PID <= 0 || samePID && status.PID != job.PID {
			return errors.New("macOS upgrade active service changed or could not be proved")
		}
	}
	return nil
}

func waitMacUpgradeService(ctx context.Context, service macUpgradeService) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		status, err := service.Status(ctx)
		if err != nil {
			return errors.New("macOS upgrade service state is unknown")
		}
		if status.Registered && status.Running && status.PID > 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("macOS upgrade service did not become ready")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func runMacUpgradeInternal(env cli.Env, args []string, ctx context.Context) int {
	if runtime.GOOS != "darwin" || len(args) != 1 || (args[0] != "mac-upgrade-check" && args[0] != "mac-upgrade-apply") {
		return fail(env, cli.ExitUsage, "invalid macOS upgrade entry point")
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home is unavailable")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS runtime paths are invalid")
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, (64<<10)+1))
	if err != nil || len(data) > 64<<10 {
		return fail(env, cli.ExitUsage, "macOS upgrade input is invalid")
	}
	var request macUpgradeRequest
	if err := decodeMacUpgradeJSON(data, &request); err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	self, sum, err := selfupdate.SelfSHA256()
	if err != nil || filepath.Clean(self) != p.ExecutablePath || sum != request.SHA256 || request.Version != env.Version || request.Pin != p.InstallDir || request.NodeBin != p.NodeBin {
		return fail(env, cli.ExitRefused, "macOS upgrade image or runtime pins are incompatible")
	}
	deps, err := nativeMacUpgradeDeps(home, p)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	stage := "check"
	if args[0] == "mac-upgrade-apply" {
		stage = "apply"
		if err := requireMacUpgradeHandoff(p, request); err != nil {
			return fail(env, cli.ExitRefused, "%v", err)
		}
	}
	if err := applyMacUpgradeImage(ctx, home, p, request, stage, deps); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	response, _ := json.Marshal(macUpgradeResponse{SHA256: sum, Version: env.Version, Stage: stage})
	printf(env.Stdout, "%s", response)
	return cli.ExitOK
}

func applyMacUpgradeImage(ctx context.Context, home string, p layout.MacRuntimePaths, request macUpgradeRequest, stage string, deps macUpgradeDeps) error {
	if stage != "check" && stage != "apply" || len(request.Keys) > 256 || len(request.Jobs) > 257 || request.Pin != p.InstallDir || request.NodeBin != p.NodeBin || deps.Service == nil {
		return errors.New("macOS upgrade input is invalid or incompatible")
	}
	if err := inspectMacUpgradePaths(home, p); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, key := range request.Keys {
		if _, err := layout.ParseConnectorInstance(string(key.Instance)); err != nil || seen[string(key.Instance)] || !hexPattern.MatchString(key.Public) {
			return errors.New("macOS upgrade expected identities are invalid")
		}
		seen[string(key.Instance)] = true
	}
	seen = map[string]bool{}
	for _, job := range request.Jobs {
		name := string(job.Kind) + ":" + string(job.Instance)
		if seen[name] || job.PID <= 0 {
			return errors.New("macOS upgrade expected services are invalid")
		}
		seen[name] = true
		if _, err := checkedMacUpgradeService(home, deps, job.Kind, job.Instance); err != nil {
			return err
		}
	}
	if err := requireMacUpgradeKeys(ctx, request.Keys, deps); err != nil {
		return err
	}
	if err := proveMacUpgradeJobs(ctx, home, request.Jobs, deps, true); err != nil {
		return err
	}
	if stage == "check" {
		return nil
	}
	if err := operator.InstallMacProbe(p); err != nil {
		return errors.New("macOS upgraded probes could not be installed")
	}
	for _, job := range request.Jobs {
		service, err := checkedMacUpgradeService(home, deps, job.Kind, job.Instance)
		if err != nil {
			return err
		}
		restartedAt := time.Now()
		if err := service.Stop(ctx); err != nil {
			return errors.New("macOS upgraded service stop failed")
		}
		status, err := service.Status(ctx)
		if err != nil || status.Registered || status.Running {
			return errors.New("macOS upgraded service stop was not proved")
		}
		if err := service.Start(ctx); err != nil {
			return errors.New("macOS upgraded service start failed")
		}
		if err := waitMacUpgradeService(ctx, service); err != nil {
			return err
		}
		if job.Kind == launchd.Connector && (deps.Admission == nil || deps.Admission(ctx, job, request.Version, restartedAt) != nil) {
			return errors.New("macOS upgraded connector admission could not be proved")
		}
		if job.Kind == launchd.Operator {
			if deps.Operator == nil || deps.Operator(ctx) != nil {
				return errors.New("macOS upgraded operator capabilities could not be proved")
			}
		}
	}
	return requireMacUpgradeKeys(ctx, request.Keys, deps)
}

func macDeployKeyPath(p layout.MacRuntimePaths) string { return filepath.Join(p.AppRoot, "deploy.key") }

func macUpgradeAdmission(p layout.MacRuntimePaths, job macUpgradeJob, version string, since time.Time) bool {
	if job.Kind != launchd.Connector || version == "" {
		return false
	}
	if _, err := layout.ParseConnectorInstance(string(job.Instance)); err != nil {
		return false
	}
	path := filepath.Join(job.Instance.DirUnder(p.StateRoot), linkAdmittedMarker)
	info, err := fsx.Lstat(path)
	if err != nil || !info.Exists || info.Size > 1024 {
		return false
	}
	data, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if err != nil || len(data) > 1024 {
		return false
	}
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key != "at" && key != "agent" || fields[key] != "" || value == "" {
			return false
		}
		fields[key] = value
	}
	at, err := time.Parse(time.RFC3339Nano, fields["at"])
	return err == nil && !at.Before(since) && !at.After(time.Now().Add(time.Second)) && admittedAs(fields["agent"], "edge-setup/"+version)
}

func waitMacUpgradeAdmission(ctx context.Context, p layout.MacRuntimePaths, job macUpgradeJob, version string, since time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	for {
		if macUpgradeAdmission(p, job, version, since) {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("macOS connector admission did not read back")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func requireMacUpgradeHandoff(p layout.MacRuntimePaths, request macUpgradeRequest) error {
	path := filepath.Join(p.AppRoot, "upgrade-recovery")
	info, err := fsx.Lstat(path)
	if err != nil || !info.Exists || !info.Dir || info.Symlink || info.Mode != 0o700 || info.Owner != fsx.Current() {
		return errors.New("macOS upgrade has no private parent transaction")
	}
	input, err := fsx.ReadRegular(filepath.Join(path, "request.json"), 0o600, fsx.Current())
	want, marshalErr := json.Marshal(request)
	if err != nil || marshalErr != nil || len(input) > 64<<10 || !bytes.Equal(input, want) {
		return errors.New("macOS upgrade handoff does not match its parent transaction")
	}
	lock, err := os.OpenFile(macSetupLockPath(p), os.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return errors.New("macOS upgrade parent lock is unavailable")
	}
	defer lock.Close()
	stat, err := lock.Stat()
	if err != nil {
		return errors.New("macOS upgrade parent lock is unsafe")
	}
	owner, ok := stat.Sys().(*syscall.Stat_t)
	if !stat.Mode().IsRegular() || stat.Mode().Perm() != 0o600 || !ok || int(owner.Uid) != os.Geteuid() {
		return errors.New("macOS upgrade parent lock is unsafe")
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		return errors.New("macOS upgrade parent transaction is not running")
	} else if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
		return errors.New("macOS upgrade parent lock state is unknown")
	}
	return nil
}
