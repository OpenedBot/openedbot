package hermes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type MacDownloader interface {
	Fetch(context.Context, string, string, download.Algorithm, string, fs.FileMode, fsx.Owner) error
}

// MacInstaller prepares one versioned, user-owned checkout before the
// command layer switches services. It never runs the installer's destructive
// venv or mutable prerequisite stages and never touches ~/.hermes.
type MacInstaller struct {
	Runner               exec.Runner
	Download             MacDownloader
	Paths                layout.MacRuntimePaths
	Home                 string
	Arch                 pins.Arch
	Log                  func(string, ...any)
	PreserveExistingVenv bool
	gitPath              string
	versionHome          string
}

func (i *MacInstaller) env() []string {
	p := i.Paths
	gitDir := ""
	if i.gitPath != "" {
		gitDir = filepath.Dir(i.gitPath) + ":"
	}
	return []string{"HOME=" + i.Home, "HERMES_HOME=" + p.RuntimeRoot,
		"PATH=" + p.VenvBin + ":" + i.uvBinDir() + ":" + i.nodeBinDir() + ":" + gitDir + "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		"VIRTUAL_ENV=" + filepath.Dir(p.VenvBin),
		"XDG_CONFIG_HOME=" + filepath.Join(p.AppRoot, "uv-config"), "UV_PYTHON_INSTALL_DIR=" + filepath.Join(p.AppRoot, "python"),
		"UV_PYTHON_BIN_DIR=" + filepath.Join(p.AppRoot, "python-bin"), "UV_CACHE_DIR=" + filepath.Join(p.AppRoot, "uv-cache"),
		"UV_PROJECT_ENVIRONMENT=" + filepath.Dir(p.VenvBin), "UV_PYTHON_DOWNLOADS=never", "TERM=dumb", "NO_COLOR=1"}
}

func (i *MacInstaller) uvBinDir() string {
	return filepath.Join(i.Paths.AppRoot, "uv", pins.UVVersion, "bin")
}
func (i *MacInstaller) nodeBinDir() string {
	return filepath.Join(i.Paths.AppRoot, "node", pins.NodeVersion, "bin")
}

// Command constructs a fixed local venv invocation. Callers choose only the
// installed python or hermes entry point, never a path from a relay request.
func (i *MacInstaller) Command(program string, args ...string) exec.Cmd {
	return exec.Cmd{Path: filepath.Join(i.Paths.VenvBin, program), Args: append([]string(nil), args...), Dir: i.Paths.RuntimeRoot, Env: i.env(), Timeout: 30 * time.Minute}
}

func (i *MacInstaller) run(ctx context.Context, action string, cmd exec.Cmd) (exec.Result, error) {
	r, err := i.Runner.Run(ctx, cmd)
	if err != nil || r.ExitCode != 0 {
		if ctx.Err() != nil {
			return r, ctx.Err()
		}
		// Installer and interpreter transcripts may contain local credentials.
		// Return the named action, never their stdout or stderr.
		return r, fmt.Errorf("%s failed", action)
	}
	return r, nil
}

func (i *MacInstaller) Prepare(ctx context.Context) error {
	if i.Runner == nil || i.Download == nil {
		return errors.New("macOS installer dependencies are missing")
	}
	want, err := layout.MacRuntime(i.Home)
	if err != nil || want != i.Paths {
		return errors.New("macOS installation paths do not belong to the managed runtime")
	}
	if i.Arch.UVTarget == "" || i.Arch.NodeTarget == "" {
		return errors.New("macOS architecture has no pinned artifacts")
	}
	i.gitPath, err = MacGit(ctx, i.Runner)
	if err != nil {
		return err
	}
	for _, path := range []string{i.Paths.AppRoot, i.Paths.RuntimeRoot, filepath.Join(i.Paths.RuntimeRoot, "logs"), filepath.Join(i.Paths.AppRoot, "downloads"), filepath.Dir(i.Paths.InstallDir)} {
		if err := fsx.EnsureDir(path, 0o700, fsx.Current()); err != nil {
			return err
		}
	}
	i.versionHome = filepath.Join(i.Paths.RuntimeRoot, ".edge-setup-version-proof")
	if err := prepareVersionHome(i.versionHome, fsx.Current()); err != nil {
		return err
	}
	if err := i.installUV(ctx); err != nil {
		return err
	}
	if err := i.installNode(ctx); err != nil {
		return err
	}
	python, err := i.installPython(ctx)
	if err != nil {
		return err
	}
	if err := i.checkout(ctx); err != nil {
		return err
	}
	if err := i.venv(ctx, python); err != nil {
		return err
	}
	return i.Prove(ctx)
}

func (i *MacInstaller) installUV(ctx context.Context) error {
	archive := filepath.Join(i.Paths.AppRoot, "downloads", "uv-"+pins.UVVersion+"-"+i.Arch.UVTarget+".tar.gz")
	if err := i.Download.Fetch(ctx, pins.UVArchiveURL(i.Arch), archive, download.SHA256, i.Arch.UVArchiveSHA256, 0o600, fsx.Current()); err != nil {
		return errors.New("pinned macOS uv download failed")
	}
	validUV, _ := download.VerifyFile(filepath.Join(i.uvBinDir(), "uv"), download.SHA256, i.Arch.UVBinarySHA256)
	validUVX, _ := download.VerifyFile(filepath.Join(i.uvBinDir(), "uvx"), download.SHA256, i.Arch.UVXBinarySHA256)
	if !validUV || !validUVX {
		if err := fsx.EnsureDir(i.uvBinDir(), 0o700, fsx.Current()); err != nil {
			return err
		}
		if _, err := i.run(ctx, "uv extraction", exec.Cmd{Path: "/usr/bin/tar", Args: []string{"-xzf", archive, "-C", i.uvBinDir(), "--strip-components=1"}}); err != nil {
			return err
		}
		for name, digest := range map[string]string{"uv": i.Arch.UVBinarySHA256, "uvx": i.Arch.UVXBinarySHA256} {
			ok, err := download.VerifyFile(filepath.Join(i.uvBinDir(), name), download.SHA256, digest)
			if err != nil || !ok {
				return errors.New("extracted macOS uv binary failed its checksum proof")
			}
		}
	}
	return nil
}

func (i *MacInstaller) installNode(ctx context.Context) error {
	archive := filepath.Join(i.Paths.AppRoot, "downloads", "node-"+pins.NodeVersion+"-darwin-"+i.Arch.NodeTarget+".tar.gz")
	if err := i.Download.Fetch(ctx, pins.MacNodeArchiveURL(i.Arch), archive, download.SHA256, i.Arch.NodeArchiveSHA256, 0o600, fsx.Current()); err != nil {
		return errors.New("pinned macOS Node download failed")
	}
	node := filepath.Join(i.nodeBinDir(), "node")
	if fsx.Exists(node) {
		r, err := i.Runner.Run(ctx, exec.Cmd{Path: node, Args: []string{"--version"}})
		if err == nil && r.ExitCode == 0 && strings.TrimSpace(r.Stdout) == pins.NodeVersion {
			return nil
		}
	}
	root := filepath.Dir(i.nodeBinDir())
	if err := fsx.EnsureDir(root, 0o700, fsx.Current()); err != nil {
		return err
	}
	if _, err := i.run(ctx, "Node extraction", exec.Cmd{Path: "/usr/bin/tar", Args: []string{"-xzf", archive, "-C", root, "--strip-components=1"}}); err != nil {
		return err
	}
	r, err := i.run(ctx, "Node version proof", exec.Cmd{Path: node, Args: []string{"--version"}})
	if err != nil {
		return err
	}
	if strings.TrimSpace(r.Stdout) != pins.NodeVersion {
		return errors.New("macOS Node version differs from the pin")
	}
	return nil
}

func (i *MacInstaller) uv(ctx context.Context, args ...string) (exec.Result, error) {
	return i.run(ctx, "pinned uv operation", exec.Cmd{Path: filepath.Join(i.uvBinDir(), "uv"), Args: args, Env: i.env(), Timeout: 60 * time.Minute})
}

func (i *MacInstaller) installPython(ctx context.Context) (string, error) {
	args := []string{"python", "find", "--managed-python", "--no-python-downloads", "--no-project", "--resolve-links", pins.PythonVersion}
	r, err := i.Runner.Run(ctx, exec.Cmd{Path: filepath.Join(i.uvBinDir(), "uv"), Args: args, Env: i.env()})
	if err != nil || r.ExitCode != 0 {
		// The explicit, pinned Python installation is the sole download stage.
		env := i.env()
		env = append(env, "UV_PYTHON_DOWNLOADS=automatic")
		if _, err := i.run(ctx, "managed Python installation", exec.Cmd{Path: filepath.Join(i.uvBinDir(), "uv"), Args: []string{"python", "install", pins.PythonVersion}, Env: env, Timeout: 30 * time.Minute}); err != nil {
			return "", err
		}
		r, err = i.uv(ctx, args...)
		if err != nil {
			return "", err
		}
	}
	python := strings.TrimSpace(r.Stdout)
	root := filepath.Join(i.Paths.AppRoot, "python")
	rel, err := filepath.Rel(root, python)
	if err != nil || !filepath.IsAbs(python) || filepath.Clean(python) != python || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("managed macOS Python path is outside its private root")
	}
	v, err := i.run(ctx, "managed Python version proof", exec.Cmd{Path: python, Args: []string{"-c", "import platform; print(platform.python_version())"}, Env: i.env()})
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(v.Stdout) != pins.PythonVersion {
		return "", errors.New("macOS Python version differs from the pin")
	}
	return python, nil
}

func (i *MacInstaller) checkout(ctx context.Context) error {
	if i.gitPath == "" {
		return errors.New("macOS Git must be verified before preparing the checkout")
	}
	if !fsx.Exists(filepath.Join(i.Paths.InstallDir, ".git")) {
		if exists, err := fsx.Lstat(i.Paths.InstallDir); err != nil {
			return err
		} else if exists.Exists {
			return errors.New("managed macOS checkout path already contains an unrecognized installation")
		}
		if err := i.Download.Fetch(ctx, pins.HermesInstallerURL, i.Paths.Installer, download.SHA256, pins.HermesInstallerSHA256, 0o700, fsx.Current()); err != nil {
			return errors.New("pinned Hermes installer download failed")
		}
		args := []string{i.Paths.Installer, "--non-interactive", "--skip-setup", "--skip-browser", "--skip-computer-use", "--dir", i.Paths.InstallDir, "--hermes-home", i.Paths.RuntimeRoot, "--branch", pins.HermesInstallerBranch, "--commit", pins.HermesInstallerCommit, "--stage", "repository"}
		if _, err := i.run(ctx, "pinned Hermes repository stage", exec.Cmd{Path: "/bin/bash", Args: args, Env: i.env(), Timeout: 30 * time.Minute}); err != nil {
			return err
		}
	}
	r, err := i.run(ctx, "Hermes commit proof", exec.Cmd{Path: i.gitPath, Args: []string{"-C", i.Paths.InstallDir, "rev-parse", "HEAD"}})
	if err != nil {
		return err
	}
	if strings.TrimSpace(r.Stdout) != pins.HermesInstallerCommit {
		return errors.New("managed Hermes checkout differs from the pinned commit")
	}
	if err := ignoreInstallStamp(i.Paths.InstallDir, fsx.Current()); err != nil {
		return err
	}
	r, err = i.run(ctx, "Hermes clean-checkout proof", exec.Cmd{Path: i.gitPath, Args: []string{"-C", i.Paths.InstallDir, "status", "--porcelain", "--untracked-files=normal"}})
	if err != nil {
		return err
	}
	if strings.TrimSpace(r.Stdout) != "" {
		return errors.New("managed Hermes checkout has local modifications; nothing was reset")
	}
	return writeInstallStamp(filepath.Join(i.Paths.InstallDir, "install-stamp.json"), fsx.Current())
}

func (i *MacInstaller) venv(ctx context.Context, python string) error {
	if _, err := i.run(ctx, "Hermes lockfile proof", exec.Cmd{Path: python, Args: []string{"-c", lockValidator, filepath.Join(i.Paths.InstallDir, "uv.lock")}, Env: i.env()}); err != nil {
		return err
	}
	venv := filepath.Dir(i.Paths.VenvBin)
	existing := fsx.Exists(venv)
	if !existing {
		if _, err := i.uv(ctx, "venv", venv, "--python", python); err != nil {
			return err
		}
	} else {
		r, err := i.run(ctx, "existing venv Python proof", i.Command("python", "-c", "import platform; print(platform.python_version())"))
		if err != nil || strings.TrimSpace(r.Stdout) != pins.PythonVersion {
			return errors.New("existing macOS venv was preserved because its Python could not be proved")
		}
	}
	r, err := i.Runner.Run(ctx, exec.Cmd{Path: filepath.Join(i.uvBinDir(), "uv"), Args: hermesSyncArgs(i.Paths.InstallDir, true), Env: i.env(), Timeout: 30 * time.Minute})
	if err == nil && r.ExitCode == 0 {
		return nil
	}
	if existing && i.PreserveExistingVenv {
		return errors.New("running gateway venv needs a dependency change; the existing environment was preserved")
	}
	if _, err := i.uv(ctx, hermesSyncArgs(i.Paths.InstallDir, false)...); err != nil {
		return err
	}
	return nil
}

// PrepareMacEnv preserves the gateway bearer and unrelated provider entries.
// Both files stay private; a replay cannot rotate an established gateway key.
func PrepareMacEnv(p layout.MacRuntimePaths) (bool, error) {
	store := EnvStore{Root: p.RuntimeRoot, Owner: fsx.Current()}
	values, err := store.SnapshotRootEnv()
	if err != nil {
		return false, err
	}
	oldShadow, err := fsx.ReadRegular(p.RuntimeEnv, 0o600, fsx.Current())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	shadowKey := ReadToken(string(oldShadow))
	envKey := values["API_SERVER_KEY"]
	if shadowKey != "" && !tokenRe.MatchString(shadowKey) || envKey != "" && !tokenRe.MatchString(envKey) {
		return false, errors.New("existing gateway bearer is invalid")
	}
	if shadowKey != "" && envKey != "" && shadowKey != envKey {
		return false, errors.New("gateway bearer sources disagree; both were preserved")
	}
	token := envKey
	if token == "" {
		token = shadowKey
	}
	if token == "" {
		token, err = NewToken()
		if err != nil {
			return false, err
		}
	}
	path := filepath.Join(p.RuntimeRoot, ".env")
	data, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	changes := map[string]dotenvChange{}
	for k, v := range parseDotEnv([]byte(RuntimeEnvContent(token))) {
		changes[k] = dotenvChange{value: v}
	}
	updated, err := updateDotEnv(data, changes, sortedChangeKeys(changes))
	if err != nil {
		return false, errors.New("gateway environment could not be prepared")
	}
	changed := string(data) != string(updated) || string(oldShadow) != RuntimeEnvContent(token)
	if string(data) != string(updated) {
		if err := fsx.WriteAtomic(path, updated, 0o600, fsx.Current()); err != nil {
			return false, err
		}
	}
	if string(oldShadow) != RuntimeEnvContent(token) {
		if err := fsx.WriteAtomic(p.RuntimeEnv, []byte(RuntimeEnvContent(token)), 0o600, fsx.Current()); err != nil {
			return false, err
		}
	}
	return changed, nil
}

func (i *MacInstaller) Configure(ctx context.Context) (bool, error) {
	path := filepath.Join(i.Paths.RuntimeRoot, "config.yaml")
	if present, err := fsx.RequireRegular(path, 0o600, fsx.Current()); err != nil {
		return false, err
	} else if !present {
		if err := fsx.WriteAtomic(path, []byte("{}\n"), 0o600, fsx.Current()); err != nil {
			return false, err
		}
	}
	changed := false
	for _, setting := range SecurityDefaults {
		r, err := i.Runner.Run(ctx, i.Command("hermes", "config", "get", setting.Key))
		if err == nil && r.ExitCode == 0 && strings.EqualFold(strings.TrimSpace(r.Stdout), setting.Value) {
			continue
		}
		if _, err := i.run(ctx, "runtime security setting", i.Command("hermes", "config", "set", setting.Key, setting.Value)); err != nil {
			return changed, err
		}
		probe, err := i.run(ctx, "runtime security setting proof", i.Command("hermes", "config", "get", setting.Key))
		if err != nil {
			return changed, err
		}
		if !strings.EqualFold(strings.TrimSpace(probe.Stdout), setting.Value) {
			return changed, errors.New("runtime security setting did not read back as requested")
		}
		changed = true
	}
	return changed, nil
}

func (i *MacInstaller) Prove(ctx context.Context) error {
	command := i.Command("hermes", "--version")
	if i.versionHome != "" {
		for n, value := range command.Env {
			if strings.HasPrefix(value, "HERMES_HOME=") {
				command.Env[n] = "HERMES_HOME=" + i.versionHome
				break
			}
		}
	}
	r, err := i.run(ctx, "Hermes version proof", command)
	if err != nil {
		return err
	}
	re := regexp.MustCompile(`(^|[^0-9.])` + regexp.QuoteMeta(pins.HermesVersion) + `([^0-9.]|$)`)
	if !re.MatchString(r.Stdout) {
		return errors.New("macOS Hermes version differs from the pin")
	}
	return nil
}
