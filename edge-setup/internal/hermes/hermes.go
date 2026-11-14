// Package hermes installs the Hermes runtime natively from pinned,
// independently proven artefacts and runs it under systemd as an
// unprivileged service user. Ported from the previous tool's `hermes` role:
//   - installer checksum, git HEAD and CLI version are all proven;
//   - the API token is generated once and never rotated on replay;
//   - interactive approvals are manual; cron and single-query modes deny;
//   - the service user has neither sudo nor docker group.
package hermes

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Installer carries the dependencies of the runtime phase.
type Installer struct {
	Runner   exec.Runner
	Apt      apt.Client
	Accounts account.Client
	Download download.Client
	Systemd  systemd.Client
	Arch     pins.Arch
	// DockerEnabled selects the gateway unit variant.
	DockerEnabled bool
	Log           func(format string, args ...any)

	// stoppedGateway records that this pass stopped a gateway it has not
	// started again yet. Every later step is allowed to fail; none of them is
	// allowed to leave the client's runtime down.
	stoppedGateway bool
	// quarantine is the directory of this pass, created on first use.
	quarantine string
	// versionHome is a private Hermes home used only for the version proof. It
	// disables the passive update check without changing the managed runtime
	// configuration or global Git settings.
	versionHome string
}

// New wires an installer over one runner.
func New(r exec.Runner, arch pins.Arch, dockerEnabled bool, log func(string, ...any)) *Installer {
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Installer{
		Runner: r, Apt: apt.New(r), Accounts: account.New(r), Download: download.Default(),
		Systemd: systemd.Client{Runner: r}, Arch: arch, DockerEnabled: dockerEnabled, Log: log,
	}
}

// Report summarises what changed.
type Report struct {
	UID                 int
	RepositoryChanged   bool
	VenvChanged         bool
	UnitChanged         bool
	ConfigChanged       bool
	Restarted           bool
	MissingProviderSDKs []ProviderSDKStatus
	// PlatformWarnings is what could not be prepared for the runtime's
	// optional platforms. It never turns a pass into a failure.
	PlatformWarnings []string
}

// UVEnv is the exact environment uv runs with: isolated configuration,
// managed Python under the tool's root, no user or global config.
func UVEnv() []string {
	return []string{
		"XDG_CONFIG_HOME=" + layout.UVConfigDir,
		"UV_PYTHON_INSTALL_DIR=" + layout.PythonInstall,
		"UV_PYTHON_BIN_DIR=" + layout.UVPythonBinDir,
		"UV_CACHE_DIR=" + layout.UVCacheDir,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
}

// CLI returns the Hermes CLI invocation as the service user.
func CLI(args ...string) exec.Cmd {
	return CLIWith(layout.VenvBin+"/hermes", args...)
}

// CLIWith runs any program of the venv as the service user, with the same
// environment as the CLI (HERMES_HOME and the venv on PATH).
func CLIWith(path string, args ...string) exec.Cmd {
	return account.AsUser(layout.ServiceUser,
		[]string{"HERMES_HOME=" + layout.RuntimeRoot, "PATH=" + layout.VenvBin + ":/usr/bin:/bin"},
		path, args...)
}

func cliAtHome(home string, args ...string) exec.Cmd {
	return account.AsUser(layout.ServiceUser,
		[]string{"HERMES_HOME=" + home, "PATH=" + layout.VenvBin + ":/usr/bin:/bin"},
		layout.VenvBin+"/hermes", args...)
}

// Run performs the account and runtime phases. Whatever fails, it never
// returns while leaving behind a gateway this pass stopped and could have
// started again: a PyPI outage of one minute must not take a client's runtime
// down until someone notices.
func (i *Installer) Run(ctx context.Context) (rep Report, err error) {
	defer func() {
		if err != nil {
			i.restoreGateway(ctx)
		}
	}()
	if err := i.Apt.Install(ctx, pins.SystemPackages...); err != nil {
		return rep, err
	}
	info, err := i.ensureServiceAccount(ctx)
	if err != nil {
		return rep, err
	}
	rep.UID = info.UID
	if err := i.prepareDirs(info); err != nil {
		return rep, err
	}
	if err := i.prepareVersionHome(info); err != nil {
		return rep, err
	}
	if err := i.installUV(ctx); err != nil {
		return rep, err
	}
	// Node is what the runtime's bridges need, not what the gateway needs:
	// its absence costs a platform, never an installation. nodejs.org being
	// unreachable must not strand a client who runs no Node platform at all.
	if _, err := i.installNode(ctx); err != nil {
		i.Log("Node %s not installed (%v); the WhatsApp and Photon bridges stay unavailable until the next pass", pins.NodeVersion, err)
	}
	rep.RepositoryChanged, err = i.installCheckout(ctx)
	if err != nil {
		return rep, err
	}
	pythonPath, err := i.installPython(ctx)
	if err != nil {
		return rep, err
	}
	rep.VenvChanged, err = i.syncVenv(ctx, pythonPath, rep.RepositoryChanged, info)
	if err != nil {
		return rep, err
	}
	if err := i.proveVersion(ctx); err != nil {
		return rep, err
	}
	i.reportProviderSDKs(ctx, &rep)
	envChanged, err := i.writeRuntimeEnv(info)
	if err != nil {
		return rep, err
	}
	cfgChanged, err := i.applySecurityDefaults(ctx)
	if err != nil {
		return rep, err
	}
	// Re-read by Hermes on its file signature: no restart of its own.
	if _, err := ApplyManagedDefaults(i.Log); err != nil {
		return rep, err
	}
	rep.ConfigChanged = envChanged || cfgChanged
	rep.UnitChanged, err = i.installUnit(info.UID)
	if err != nil {
		return rep, err
	}
	rep.Restarted, err = i.startGateway(ctx, rep.RepositoryChanged || rep.VenvChanged || rep.ConfigChanged || rep.UnitChanged)
	if err != nil {
		return rep, err
	}
	// Platforms come last, once the runtime serves openedbot, and their
	// failures are reported rather than raised: a registry outage must not
	// undo an installation that is otherwise complete.
	rep.PlatformWarnings = i.preparePlatforms(ctx, info)
	for _, w := range rep.PlatformWarnings {
		i.Log("platform: %s", w)
	}
	return rep, nil
}

func (i *Installer) ensureServiceAccount(ctx context.Context) (*account.Info, error) {
	info, err := i.Accounts.EnsureSystemUser(ctx, layout.ServiceUser, "/home/"+layout.ServiceUser)
	if err != nil {
		return nil, err
	}
	if err := i.Accounts.RequireUnprivileged(ctx, layout.ServiceUser); err != nil {
		return nil, err
	}
	return info, nil
}

func (i *Installer) prepareDirs(info *account.Info) error {
	owner := fsx.Owner{UID: info.UID, GID: info.GID}
	if err := fsx.EnsureDir(layout.RuntimeRoot, 0o700, owner); err != nil {
		return err
	}
	if err := fsx.EnsureDir(layout.RuntimeRoot+"/workspace", 0o750, owner); err != nil {
		return err
	}
	if err := fsx.EnsureDir(layout.RuntimeRoot+"/home", 0o700, owner); err != nil {
		return err
	}
	for _, d := range []string{layout.UVRoot, layout.UVPythonBinDir, layout.UVConfigDir, layout.PythonInstall, layout.BootstrapHome} {
		if err := fsx.EnsureDir(d, 0o755, fsx.Root); err != nil {
			return err
		}
	}
	if err := fsx.EnsureDir(layout.DownloadDir, 0o700, fsx.Root); err != nil {
		return err
	}
	// The managed cache is reset before every run so nothing from a previous
	// unprivileged build survives.
	if err := os.RemoveAll(layout.UVCacheDir); err != nil {
		return err
	}
	return fsx.EnsureDir(layout.UVCacheDir, 0o700, fsx.Root)
}

func (i *Installer) prepareVersionHome(info *account.Info) error {
	i.versionHome = layout.RuntimeRoot + "/.edge-setup-version-proof"
	return prepareVersionHome(i.versionHome, fsx.Owner{UID: info.UID, GID: info.GID})
}

func (i *Installer) installUV(ctx context.Context) error {
	archive := layout.UVArchivePath()
	if err := i.Download.Fetch(ctx, pins.HermesInstallerURL, layout.InstallerPath, download.SHA256, pins.HermesInstallerSHA256, 0o700, fsx.Root); err != nil {
		return err
	}
	if err := i.Download.Fetch(ctx, pins.UVArchiveURL(i.Arch), archive, download.SHA256, i.Arch.UVArchiveSHA256, 0o600, fsx.Root); err != nil {
		return err
	}
	uvOK, _ := download.VerifyFile(layout.UVBinary, download.SHA256, i.Arch.UVBinarySHA256)
	uvxOK, _ := download.VerifyFile(layout.UVRoot+"/uvx", download.SHA256, i.Arch.UVXBinarySHA256)
	if !uvOK || !uvxOK {
		if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/usr/bin/tar", Args: []string{"-xzf", archive, "-C", layout.UVRoot, "--strip-components=1"}}); err != nil {
			return err
		}
	}
	for _, bin := range []string{layout.UVBinary, layout.UVRoot + "/uvx"} {
		if err := os.Chmod(bin, 0o755); err != nil {
			return err
		}
		if err := os.Chown(bin, 0, 0); err != nil && os.Geteuid() == 0 {
			return err
		}
	}
	if ok, err := download.VerifyFile(layout.UVBinary, download.SHA256, i.Arch.UVBinarySHA256); err != nil || !ok {
		return errors.New("the extracted uv binary does not match the pinned archive")
	}
	if ok, err := download.VerifyFile(layout.UVRoot+"/uvx", download.SHA256, i.Arch.UVXBinarySHA256); err != nil || !ok {
		return errors.New("the extracted uvx binary does not match the pinned archive")
	}
	out, err := exec.Output(ctx, i.Runner, layout.UVBinary, "--version")
	if err != nil {
		return err
	}
	if want := fmt.Sprintf("uv %s (%s)", pins.UVVersion, i.Arch.UVTarget); out != want {
		return fmt.Errorf("unexpected uv: %q, want %q", out, want)
	}
	return nil
}

func (i *Installer) git(ctx context.Context, args ...string) (exec.Result, error) {
	return i.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/git", Args: append([]string{"-C", layout.InstallDir}, args...)})
}

// installCheckout installs or repoints the pinned Hermes checkout. It reads
// HEAD rather than a marker: a partial or modified install must never claim
// to be at the expected commit.
func (i *Installer) installCheckout(ctx context.Context) (bool, error) {
	st, err := fsx.Lstat(layout.InstallDir)
	if err != nil {
		return false, err
	}
	if st.Exists && (!st.Dir || st.Symlink) {
		return false, errors.New("the managed Hermes checkout must be a regular directory, not a symlink")
	}
	installed := ""
	gatewayStopped := false
	if st.Exists {
		if err := i.sweepRuntimeProbes(); err != nil {
			return false, err
		}
		res, err := i.git(ctx, "rev-parse", "HEAD")
		if err != nil {
			return false, err
		}
		if res.ExitCode == 0 {
			installed = strings.TrimSpace(res.Stdout)
			if err := ignoreInstallStamp(layout.InstallDir, fsx.Root); err != nil {
				return false, err
			}
			status, err := i.git(ctx, "status", "--porcelain=v1", "--untracked-files=all")
			if err != nil {
				return false, err
			}
			if strings.TrimSpace(status.Stdout) != "" {
				if err := i.quarantineUntrackedFiles(status.Stdout); err != nil {
					return false, err
				}
				if err := i.stopGatewayIfPresent(ctx); err != nil {
					return false, err
				}
				gatewayStopped = true
				i.Log("Hermes checkout has local modifications; resetting managed checkout at %s", layout.InstallDir)
				if err := i.resetDirtyCheckout(ctx); err != nil {
					return false, err
				}
			}
		}
	}
	needed := installed != pins.HermesInstallerCommit
	if err := i.installRepository(ctx, needed, gatewayStopped); err != nil {
		return false, err
	}
	head, err := i.git(ctx, "rev-parse", "HEAD")
	if err != nil || head.ExitCode != 0 || strings.TrimSpace(head.Stdout) != pins.HermesInstallerCommit {
		return false, fmt.Errorf("unexpected Hermes checkout %q, want %s", strings.TrimSpace(head.Stdout), pins.HermesInstallerCommit)
	}
	status, err := i.git(ctx, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil || strings.TrimSpace(status.Stdout) != "" {
		return false, errors.New("the Hermes checkout is not clean after installation")
	}
	if err := i.ownRoot(ctx, layout.InstallDir+"/hermes_agent.egg-info"); err != nil {
		return false, err
	}
	if err := i.requireRootOwnedSource(ctx, true); err != nil {
		return false, err
	}
	if err := writeInstallStamp(layout.InstallDir+"/install-stamp.json", fsx.Root); err != nil {
		return false, err
	}
	return needed, nil
}

// Resetting a dirty old checkout already stopped the gateway. That must not
// skip the repository stage that moves it to the new pin.
func (i *Installer) installRepository(ctx context.Context, needed, gatewayStopped bool) error {
	if needed {
		if !gatewayStopped {
			if err := i.stopGatewayIfPresent(ctx); err != nil {
				return err
			}
		}
		_, err := exec.Must(ctx, i.Runner, exec.Cmd{
			Path: "/bin/bash",
			Args: []string{layout.InstallerPath, "--non-interactive", "--skip-setup", "--skip-browser", "--skip-computer-use",
				"--dir", layout.InstallDir, "--hermes-home", layout.BootstrapHome,
				"--branch", pins.HermesInstallerBranch, "--commit", pins.HermesInstallerCommit, "--stage", "repository"},
			Env:     []string{"HOME=" + layout.BootstrapHome, "HERMES_HOME=" + layout.BootstrapHome, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
			Timeout: 30 * time.Minute,
		})
		return err
	}
	return nil
}

// resetDirtyCheckout makes the root-owned checkout canonical before the
// pinned upstream installer is allowed to update it. The managed checkout is
// not a customer configuration surface, so local source changes are replaced
// without an interactive prompt. Runtime data lives under /srv/hermes/data.
func (i *Installer) resetDirtyCheckout(ctx context.Context) error {
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{
		Path: "/usr/bin/git",
		Args: []string{"-C", layout.InstallDir, "reset", "--hard", "HEAD"},
	}); err != nil {
		return fmt.Errorf("reset modified Hermes checkout: %w", err)
	}
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{
		Path: "/usr/bin/git",
		Args: []string{"-C", layout.InstallDir, "clean", "-ffd", "--"},
	}); err != nil {
		return fmt.Errorf("clean modified Hermes checkout: %w", err)
	}
	return nil
}

func (i *Installer) stopGatewayIfPresent(ctx context.Context) error {
	exists, err := fsx.RequireRegular(layout.GatewayUnitPath, 0, fsx.Root)
	if err != nil {
		return fmt.Errorf("existing gateway unit: %w", err)
	}
	if !exists {
		return nil
	}
	if err := i.Systemd.Stop(ctx, layout.GatewayUnit); err != nil {
		return err
	}
	i.stoppedGateway = true
	return nil
}

// restoreGateway starts again a gateway this pass stopped, once, and only on
// an installation that still proves itself: starting on a venv `uv sync` left
// half written would replace a clear failure with a crash loop. When the
// proof fails the runtime stays down on purpose, and the reason is printed.
func (i *Installer) restoreGateway(ctx context.Context) {
	if !i.stoppedGateway {
		return
	}
	// The pass may have failed because the context was cancelled; putting the
	// client's runtime back up is exactly what must still happen then.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
	defer cancel()
	if err := i.proveVersion(ctx); err != nil {
		i.Log("gateway left stopped: this installation does not prove itself (%v)", err)
		return
	}
	if err := i.Systemd.Start(ctx, layout.GatewayUnit); err != nil {
		i.Log("gateway left stopped: %v", err)
		return
	}
	i.stoppedGateway = false
	i.Log("gateway started again: the pass failed, the previous installation is intact")
}

// sweepRuntimeProbes takes the runtime's leftover write probes out of the
// checkout before anything reads `git status`, so a zero-byte file does not
// cost the client a gateway restart and a hard reset.
func (i *Installer) sweepRuntimeProbes() error {
	moved, err := sweepProbes(layout.InstallDir, i.quarantineRoot(), fsx.Root)
	if err != nil {
		return fmt.Errorf("sweep runtime probes: %w", err)
	}
	if len(moved) > 0 {
		i.Log("runtime write probes moved to %s: %s", i.quarantineRoot(), strings.Join(moved, ", "))
	}
	return nil
}

// quarantineUntrackedFiles preserves what `git clean -ffd` is about to remove.
func (i *Installer) quarantineUntrackedFiles(porcelain string) error {
	moved, err := quarantineUntracked(layout.InstallDir, i.quarantineRoot(), porcelain, fsx.Root)
	if err != nil {
		return fmt.Errorf("quarantine untracked checkout files: %w", err)
	}
	if len(moved) > 0 {
		i.Log("%d untracked file(s) kept in %s before the reset", len(moved), i.quarantineRoot())
	}
	return nil
}

func (i *Installer) quarantineRoot() string {
	if i.quarantine == "" {
		i.quarantine = quarantineDir(layout.ToolQuarantineDir, time.Now())
	}
	return i.quarantine
}

// ownRoot makes a tree root-owned with u=rwX,g=rX,o=rX (idempotent).
func (i *Installer) ownRoot(ctx context.Context, path string) error {
	if !fsx.Exists(path) {
		return nil
	}
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/bin/chown", Args: []string{"-R", "root:root", path}}); err != nil {
		return err
	}
	_, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/bin/chmod", Args: []string{"-R", "u=rwX,g=rX,o=rX", path}})
	return err
}

// requireRootOwnedSource proves nothing under the checkout is writable by
// anyone but root. With pruneVenv the venv is skipped (before the sync).
//
// A rejected path is repaired first, then the proof is replayed. The runtime
// legitimately drops build artefacts in the checkout (a `node_modules` a
// bridge installed, an egg-info): refusing to install because of them would
// strand the host on an old edge-setup, which is precisely how a client ends
// up unable to receive the fix for that very problem. Reclaiming changes no
// file content, and the invariant is still proven, never assumed.
func (i *Installer) requireRootOwnedSource(ctx context.Context, pruneVenv bool) error {
	out, err := exec.Output(ctx, i.Runner, "/usr/bin/find", rootOwnedSourceArgs(pruneVenv)...)
	if err != nil {
		return err
	}
	if out == "" {
		return nil
	}
	reclaimed, err := i.reclaimWritableSource(ctx, pruneVenv)
	if err != nil {
		return fmt.Errorf("reclaim hermes code at %s: %w", out, err)
	}
	out, err = exec.Output(ctx, i.Runner, "/usr/bin/find", rootOwnedSourceArgs(pruneVenv)...)
	if err != nil {
		return err
	}
	if out != "" {
		return fmt.Errorf("hermes code writable outside root: %s", out)
	}
	i.Log("reclaimed for root: %s", strings.Join(reclaimed, ", "))
	return nil
}

// reclaimWritableSource makes every path the proof rejected root-owned and
// unwritable to others.
func (i *Installer) reclaimWritableSource(ctx context.Context, pruneVenv bool) ([]string, error) {
	out, err := exec.Output(ctx, i.Runner, "/usr/bin/find", sourceScanArgs(pruneVenv, false)...)
	if err != nil {
		return nil, err
	}
	roots := repairRoots(strings.Split(out, "\n"), maxRepairRoots)
	for _, path := range roots {
		if err := i.ownRoot(ctx, path); err != nil {
			return nil, err
		}
	}
	return roots, nil
}

func rootOwnedSourceArgs(pruneVenv bool) []string { return sourceScanArgs(pruneVenv, true) }

// sourceScanArgs builds the ownership scan. With stopAtFirst it is the proof
// (one path is enough to fail); without it, it is the repair list.
func sourceScanArgs(pruneVenv, stopAtFirst bool) []string {
	args := []string{layout.InstallDir, "-xdev"}
	if pruneVenv {
		// npm creates launcher symlinks such as node_modules/.bin/semver.
		// Linux reports a symlink's lstat mode as 0777, which is not a
		// writable target inode. The containing directories remain checked.
		args = append(args, "(", "-path", layout.InstallDir+"/venv", "-o", "-type", "l", ")", "-prune", "-o")
	} else {
		args = append(args, "-type", "l", "-prune", "-o")
	}
	args = append(args, "(", "!", "-user", "root", "-o", "-perm", "/022", ")", "-print")
	if stopAtFirst {
		args = append(args, "-quit")
	}
	return args
}

// managedPythonRe is the uv-managed interpreter of the pinned minor version
// (pins.PythonMinor), never a hardcoded one: a Python pin bump moves it too.
var managedPythonRe = regexp.MustCompile(`^/usr/local/share/hermes-python/.+/bin/python` + regexp.QuoteMeta(pins.PythonMinor()) + `$`)

func (i *Installer) uv(ctx context.Context, extraEnv []string, args ...string) (exec.Result, error) {
	return i.Runner.Run(ctx, exec.Cmd{Path: layout.UVBinary, Args: args, Env: append(UVEnv(), extraEnv...), Timeout: 30 * time.Minute})
}

func (i *Installer) installPython(ctx context.Context) (string, error) {
	find := []string{"python", "find", "--managed-python", "--no-python-downloads", "--no-project", pins.PythonVersion}
	res, err := i.uv(ctx, nil, find...)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: layout.UVBinary, Args: []string{"python", "install", pins.PythonVersion}, Env: UVEnv(), Timeout: 30 * time.Minute}); err != nil {
			return "", err
		}
	}
	res, err = exec.Must(ctx, i.Runner, exec.Cmd{Path: layout.UVBinary, Args: []string{"python", "find", "--managed-python", "--no-python-downloads", "--no-project", "--resolve-links", pins.PythonVersion}, Env: UVEnv()})
	if err != nil {
		return "", err
	}
	path := strings.TrimSpace(res.Stdout)
	if !managedPythonRe.MatchString(path) {
		return "", fmt.Errorf("unexpected managed Python interpreter: %q", path)
	}
	// uv leaves a world-writable lock file next to its managed interpreters;
	// nothing under /usr/local/share may be writable by others.
	if lock := layout.PythonInstall + "/.lock"; fsx.Exists(lock) {
		if err := os.Chmod(lock, 0o644); err != nil {
			return "", err
		}
	}
	return path, nil
}

// lockValidator gates every lock source before uv touches the network. PyPI
// and the editable checkout are allowed as before (every PyPI artefact
// hashed). Since Hermes 0.22 the lock also carries a few GitHub sources; by
// operator decision (2026-10-21) exactly two shapes are accepted, both content
// addressed: a direct https://github.com/ URL whose every artefact is
// sha256-hashed, and a https://github.com/ git repository pinned on a full
// 40-hex commit (rev and fragment equal). Anything else is refused.
const lockValidator = `import pathlib, re, sys, tomllib

lock = tomllib.loads(pathlib.Path(sys.argv[1]).read_text())
allowed = (
    {"registry": "https://pypi.org/simple"},
    {"editable": "."},
)
GITHUB_URL = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_./%+-]+$")
GITHUB_GIT = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?(?:\.git)?\?rev=([0-9a-f]{40})#([0-9a-f]{40})$")

def hashed(artifacts):
    return bool(artifacts) and all(str(item.get("hash", "")).startswith("sha256:") for item in artifacts)

for package in lock.get("package", []):
    name = package.get("name")
    source = package.get("source", {})
    artifacts = ([package["sdist"]] if "sdist" in package else []) + package.get("wheels", [])
    if source in allowed:
        if "registry" in source and not hashed(artifacts):
            raise SystemExit(f"unhashed lock artifact for {name}")
        continue
    if set(source) == {"url"}:
        url = str(source["url"])
        if ".." in url or not GITHUB_URL.match(url) or not hashed(artifacts) or any(not GITHUB_URL.match(str(item.get("url", ""))) for item in artifacts):
            raise SystemExit(f"untrusted lock source for {name}: {source}")
        continue
    if set(source) == {"git"}:
        match = GITHUB_GIT.match(str(source["git"]))
        if not match or match.group(1) != match.group(2) or ".." in str(source["git"]):
            raise SystemExit(f"untrusted lock source for {name}: {source}")
        continue
    raise SystemExit(f"untrusted lock source for {name}: {source}")
`

func (i *Installer) syncVenv(ctx context.Context, pythonPath string, repoChanged bool, info *account.Info) (bool, error) {
	venv := layout.InstallDir + "/venv"
	venvPython, err := i.Runner.Run(ctx, exec.Cmd{Path: layout.VenvBin + "/python", Args: []string{"-c", "import platform; print(platform.python_version())"}})
	rebuild := err != nil || venvPython.ExitCode != 0 || strings.TrimSpace(venvPython.Stdout) != pins.PythonVersion
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: pythonPath, Args: []string{"-c", lockValidator, layout.InstallDir + "/uv.lock"}}); err != nil {
		return false, fmt.Errorf("uv.lock validation: %w", err)
	}
	projectEnv := []string{"UV_PROJECT_ENVIRONMENT=" + venv, "UV_PYTHON_DOWNLOADS=never"}
	check := func() bool {
		res, err := i.uv(ctx, projectEnv, hermesSyncArgs(layout.InstallDir, true)...)
		return err == nil && res.ExitCode == 0
	}
	required := rebuild || repoChanged || !check()
	if !required {
		return false, nil
	}
	if err := i.stopGatewayIfPresent(ctx); err != nil {
		return false, err
	}
	if rebuild {
		if err := os.RemoveAll(venv); err != nil {
			return false, err
		}
		if _, err := i.uvMust(ctx, []string{"UV_PYTHON_DOWNLOADS=never"}, "venv", venv, "--python", pythonPath); err != nil {
			return false, err
		}
	}
	// Hand the venv, the editable metadata and a fresh cache to the
	// unprivileged builder, run the locked sync as that user, then reclaim
	// everything unconditionally.
	builder := fsx.Owner{UID: info.UID, GID: info.GID}
	cacheParent := filepath.Dir(layout.UVCacheDir)
	syncErr := func() error {
		if err := fsx.EnsureDir(cacheParent, 0o710, fsx.Owner{UID: 0, GID: info.GID}); err != nil {
			return err
		}
		for _, p := range []string{layout.InstallDir + "/hermes_agent.egg-info", layout.UVCacheDir, venv} {
			if err := fsx.EnsureDir(p, 0o700, builder); err != nil {
				return err
			}
			if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/bin/chown", Args: []string{"-R", fmt.Sprintf("%d:%d", info.UID, info.GID), p}}); err != nil {
				return err
			}
		}
		env := append([]string{"HOME=/home/" + layout.ServiceUser}, UVEnv()...)
		env = append(env, projectEnv...)
		cmd := account.AsUser(layout.ServiceUser, env, layout.UVBinary, hermesSyncArgs(layout.InstallDir, false)...)
		cmd.Timeout = 60 * time.Minute
		_, err := exec.Must(ctx, i.Runner, cmd)
		return err
	}()
	// Reclaim, always.
	for _, p := range []string{layout.InstallDir + "/hermes_agent.egg-info", venv} {
		if err := i.ownRoot(ctx, p); err != nil {
			return false, err
		}
	}
	if err := os.RemoveAll(layout.UVCacheDir); err != nil {
		return false, err
	}
	if err := fsx.EnsureDir(layout.UVCacheDir, 0o700, fsx.Root); err != nil {
		return false, err
	}
	if err := fsx.EnsureDir(cacheParent, 0o700, fsx.Root); err != nil {
		return false, err
	}
	if syncErr != nil {
		return false, syncErr
	}
	if err := i.requireRootOwnedSource(ctx, false); err != nil {
		return false, err
	}
	if !check() {
		return false, errors.New("the locked environment does not verify after synchronisation")
	}
	status, err := i.git(ctx, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil || strings.TrimSpace(status.Stdout) != "" {
		return false, errors.New("the locked installation modified the checkout")
	}
	return true, nil
}

func (i *Installer) uvMust(ctx context.Context, extraEnv []string, args ...string) (exec.Result, error) {
	return exec.Must(ctx, i.Runner, exec.Cmd{Path: layout.UVBinary, Args: args, Env: append(UVEnv(), extraEnv...), Timeout: 30 * time.Minute})
}

func (i *Installer) proveVersion(ctx context.Context) error {
	res, err := exec.Must(ctx, i.Runner, i.versionCommand())
	if err != nil {
		return err
	}
	re := regexp.MustCompile(`(^|[^0-9.])` + regexp.QuoteMeta(pins.HermesVersion) + `([^0-9.]|$)`)
	if !re.MatchString(res.Stdout) {
		return fmt.Errorf("unexpected installed version: `hermes --version` printed %q, want %s", strings.TrimSpace(res.Stdout), pins.HermesVersion)
	}
	return nil
}

func (i *Installer) versionCommand() exec.Cmd {
	if i.versionHome == "" {
		return CLI("--version")
	}
	return cliAtHome(i.versionHome, "--version")
}

var tokenRe = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)

// RuntimeEnvContent renders runtime.env for a token.
func RuntimeEnvContent(token string) string {
	return fmt.Sprintf("API_SERVER_ENABLED=true\nAPI_SERVER_HOST=%s\nAPI_SERVER_PORT=%d\nAPI_SERVER_KEY=%s\nAPI_SERVER_CORS_ORIGINS=\n", layout.GatewayHost, layout.GatewayPort, token)
}

// ReadToken extracts API_SERVER_KEY from runtime.env content.
func ReadToken(env string) string {
	for _, line := range strings.Split(env, "\n") {
		if v, ok := strings.CutPrefix(line, "API_SERVER_KEY="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// NewToken generates a 256-bit hexadecimal bearer.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// writeRuntimeEnv writes runtime.env, keeping an existing token: rotating it
// on replay would silently disconnect the application.
func (i *Installer) writeRuntimeEnv(info *account.Info) (bool, error) {
	return writeRuntimeEnvAt(layout.RuntimeEnv, fsx.Owner{UID: info.UID, GID: info.GID}, i.Log)
}

// writeRuntimeEnvAt is writeRuntimeEnv for the file at path. The service user
// can replace that file, so the existing token is read from the descriptor
// the mode and owner were checked on (fsx.ReadRegular), never from a second
// look at the name.
func writeRuntimeEnvAt(path string, owner fsx.Owner, log func(string, ...any)) (bool, error) {
	if err := TightenSecretFile(path, owner, log); err != nil {
		return false, fmt.Errorf("existing runtime.env: %w", err)
	}
	token := ""
	current := ""
	data, err := fsx.ReadRegular(path, 0o600, owner)
	switch {
	case errors.Is(err, os.ErrNotExist):
		// First install: there is no token to keep.
	case err != nil:
		return false, fmt.Errorf("existing runtime.env: %w", err)
	default:
		current = string(data)
		token = ReadToken(current)
		if token != "" && !tokenRe.MatchString(token) {
			return false, errors.New("existing API_SERVER_KEY does not satisfy the 256-bit hexadecimal contract")
		}
	}
	// Multiplexed Hermes reloads even the default profile's credentials from
	// .env without falling back to systemd's process environment. runtime.env
	// remains authoritative for the connector when migrating an existing host.
	profilePath := filepath.Join(filepath.Dir(path), ".env")
	if err := TightenSecretFile(profilePath, owner, log); err != nil {
		return false, fmt.Errorf("existing gateway .env: %w", err)
	}
	profileData, err := fsx.ReadRegular(profilePath, 0o600, owner)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("existing gateway .env: %w", err)
	}
	if token == "" {
		token = parseDotEnv(profileData)["API_SERVER_KEY"]
		if token != "" && !tokenRe.MatchString(token) {
			return false, errors.New("existing API_SERVER_KEY does not satisfy the 256-bit hexadecimal contract")
		}
	}
	if token == "" {
		token, err = NewToken()
		if err != nil {
			return false, err
		}
	}
	content := RuntimeEnvContent(token)
	changes := map[string]dotenvChange{}
	for key, value := range parseDotEnv([]byte(content)) {
		changes[key] = dotenvChange{value: value}
	}
	profileContent, err := updateDotEnv(profileData, changes, sortedChangeKeys(changes))
	if err != nil {
		return false, errors.New("gateway environment could not be prepared")
	}
	changed := content != current || string(profileData) != string(profileContent)
	if content != current {
		if err := fsx.WriteAtomic(path, []byte(content), 0o600, owner); err != nil {
			return false, err
		}
	}
	if string(profileData) != string(profileContent) {
		if err := fsx.WriteAtomic(profilePath, profileContent, 0o600, owner); err != nil {
			return false, err
		}
	}
	return changed, nil
}

// SecurityDefaults are the config keys the runtime must carry. Read before
// write: `config set` prints "Set …" even for an unchanged value and a
// restart on every replay would cut running sessions.
var SecurityDefaults = []struct{ Key, Value string }{
	{"approvals.mode", "manual"},
	{"approvals.cron_mode", "deny"},
	{"approvals.single_query_mode", "deny"},
	{"security.allow_lazy_installs", "false"},
	{"gateway.multiplex_profiles", "true"},
}

func (i *Installer) applySecurityDefaults(ctx context.Context) (bool, error) {
	return ApplySecurityDefaults(ctx, i.Runner, i.Log)
}

// ApplySecurityDefaults reconciles the runtime's fail-closed configuration
// under the service user. It is shared by `up` and `upgrade`: an existing host
// must receive new security defaults without duplicating or subtly changing
// the read-before-write proof.
func ApplySecurityDefaults(ctx context.Context, runner exec.Runner, log func(string, ...any)) (bool, error) {
	// The CLI below reads and writes this file as the service user: a
	// root-owned or 0644 config.yaml, which one `sudo hermes config set` is
	// enough to produce, used to fail `up`, every `upgrade`, and the rollback
	// of that upgrade alike. Repair it, then require it.
	if err := TightenSecretFile(layout.RuntimeConfig, ServiceOwner(), log); err != nil {
		return false, fmt.Errorf("existing config.yaml: %w", err)
	}
	exists, err := fsx.RequireRegular(layout.RuntimeConfig, 0o600, fsx.Owner{UID: -1, GID: -1})
	if exists && err != nil && !strings.Contains(err.Error(), "owner") {
		return false, fmt.Errorf("existing config.yaml: %w", err)
	}
	changed := false
	for _, kv := range SecurityDefaults {
		cur, _ := runner.Run(ctx, CLI("config", "get", kv.Key))
		if strings.EqualFold(strings.TrimSpace(cur.Stdout), kv.Value) && cur.ExitCode == 0 {
			continue
		}
		if _, err := exec.Must(ctx, runner, CLI("config", "set", kv.Key, kv.Value)); err != nil {
			return changed, err
		}
		changed = true
		probe, err := exec.Must(ctx, runner, CLI("config", "get", kv.Key))
		if err != nil {
			return changed, err
		}
		if !strings.EqualFold(strings.TrimSpace(probe.Stdout), kv.Value) {
			return changed, fmt.Errorf("%s=%s, want %s", kv.Key, strings.TrimSpace(probe.Stdout), kv.Value)
		}
	}
	// On a first install the CLI creates config.yaml itself, under the
	// inherited umask (0644): put it back to owner-only before P9 audits it.
	if err := TightenSecretFile(layout.RuntimeConfig, ServiceOwner(), log); err != nil {
		return changed, fmt.Errorf("config.yaml: %w", err)
	}
	return changed, nil
}

func (i *Installer) installUnit(uid int) (bool, error) {
	content, err := gatewayUnitText(i.DockerEnabled, uid, layout.ResolvConf, i.Log)
	if err != nil {
		return false, err
	}
	if data, err := os.ReadFile(layout.GatewayUnitPath); err == nil && string(data) == content {
		return false, nil
	}
	return true, fsx.WriteAtomic(layout.GatewayUnitPath, []byte(content), 0o644, fsx.Root)
}

func (i *Installer) startGateway(ctx context.Context, restart bool) (bool, error) {
	if err := i.Systemd.DaemonReload(ctx); err != nil {
		return false, err
	}
	if err := i.Systemd.Enable(ctx, layout.GatewayUnit); err != nil {
		return false, err
	}
	if restart {
		if err := i.Systemd.Restart(ctx, layout.GatewayUnit); err != nil {
			return false, err
		}
	} else if err := i.Systemd.Start(ctx, layout.GatewayUnit); err != nil {
		return false, err
	}
	// From here the runtime is up: an unhealthy gateway is a failure to
	// report, not a service this pass still owes the client.
	i.stoppedGateway = false
	// The service can be active before the port listens: /health decides.
	return restart, gateway.Loopback("").WaitHealthy(ctx, 60*time.Second)
}

// Token reads the bearer from runtime.env (mode 0600, owned by the service
// account; the CLI reads it as root).
func Token() (string, error) {
	data, err := os.ReadFile(layout.RuntimeEnv)
	if err != nil {
		return "", err
	}
	t := ReadToken(string(data))
	if !gateway.ValidToken(t) {
		return "", errors.New("runtime.env carries no valid API_SERVER_KEY")
	}
	return t, nil
}
