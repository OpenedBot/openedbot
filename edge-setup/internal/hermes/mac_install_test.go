package hermes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type macFetchCall struct {
	url, dest string
	algo      download.Algorithm
	want      string
	mode      os.FileMode
	owner     fsx.Owner
}

type fixtureMacDownloader struct {
	files  map[string][]byte
	verify bool
	calls  []macFetchCall
}

func (d *fixtureMacDownloader) Fetch(_ context.Context, url, dest string, algo download.Algorithm, want string, mode os.FileMode, owner fsx.Owner) error {
	d.calls = append(d.calls, macFetchCall{url: url, dest: dest, algo: algo, want: want, mode: mode, owner: owner})
	data, ok := d.files[url]
	if !ok {
		return errors.New("fixture has no artifact for requested URL")
	}
	if d.verify && want != "" && want != fixtureSHA256(data) {
		return errors.New("fixture artifact digest differs from request")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	return fsx.WriteAtomic(dest, data, mode, owner)
}

type macInstallerRunner struct {
	calls []exec.Cmd
	run   func(exec.Cmd) (exec.Result, error)
}

func (r *macInstallerRunner) Run(_ context.Context, cmd exec.Cmd) (exec.Result, error) {
	cmd.Args = append([]string(nil), cmd.Args...)
	cmd.Env = append([]string(nil), cmd.Env...)
	r.calls = append(r.calls, cmd)
	if r.run == nil {
		return exec.Result{}, errors.New("unexpected fixture command")
	}
	return r.run(cmd)
}

func TestMacInstallerUsesCustomArtifactPinsAndVerifiesExtractedBinaries(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	uvArchive := []byte("fixture uv archive")
	uvBinary := []byte("fixture uv binary")
	uvxBinary := []byte("fixture uvx binary")
	nodeArchive := []byte("fixture node archive")
	arch := pins.Arch{
		Go: "arm64", UVTarget: "fixture-apple-darwin", UVArchiveSHA256: fixtureSHA256(uvArchive),
		UVBinarySHA256: fixtureSHA256(uvBinary), UVXBinarySHA256: fixtureSHA256(uvxBinary),
		NodeTarget: "fixture-arm64", NodeArchiveSHA256: fixtureSHA256(nodeArchive),
	}
	dl := &fixtureMacDownloader{verify: true, files: map[string][]byte{
		pins.UVArchiveURL(arch):      uvArchive,
		pins.MacNodeArchiveURL(arch): nodeArchive,
	}}
	var installer *MacInstaller
	runner := &macInstallerRunner{run: func(cmd exec.Cmd) (exec.Result, error) {
		switch cmd.Path {
		case "/usr/bin/tar":
			if len(cmd.Args) < 5 || cmd.Args[0] != "-xzf" || cmd.Args[2] != "-C" {
				return exec.Result{}, errors.New("unexpected extraction arguments")
			}
			dest := cmd.Args[3]
			if dest == installer.uvBinDir() {
				if err := writeExecutableFixture(filepath.Join(dest, "uv"), uvBinary); err != nil {
					return exec.Result{}, err
				}
				if err := writeExecutableFixture(filepath.Join(dest, "uvx"), uvxBinary); err != nil {
					return exec.Result{}, err
				}
				return exec.Result{}, nil
			}
			if dest == filepath.Dir(installer.nodeBinDir()) {
				if err := writeExecutableFixture(filepath.Join(installer.nodeBinDir(), "node"), []byte("fixture node executable")); err != nil {
					return exec.Result{}, err
				}
				return exec.Result{}, nil
			}
			return exec.Result{}, errors.New("unexpected extraction destination")
		case filepath.Join(paths.AppRoot, "node", pins.NodeVersion, "bin", "node"):
			return exec.Result{Stdout: pins.NodeVersion + "\n"}, nil
		default:
			return exec.Result{}, errors.New("unexpected fixture command")
		}
	}}
	installer = &MacInstaller{Runner: runner, Download: dl, Paths: paths, Home: home, Arch: arch}

	if err := installer.installUV(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := installer.installNode(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(dl.calls) != 2 {
		t.Fatalf("expected two pinned artifact requests, got %d", len(dl.calls))
	}
	wantCalls := []macFetchCall{
		{url: pins.UVArchiveURL(arch), dest: filepath.Join(paths.AppRoot, "downloads", "uv-"+pins.UVVersion+"-"+arch.UVTarget+".tar.gz"), algo: download.SHA256, want: arch.UVArchiveSHA256, mode: 0o600, owner: fsx.Current()},
		{url: pins.MacNodeArchiveURL(arch), dest: filepath.Join(paths.AppRoot, "downloads", "node-"+pins.NodeVersion+"-darwin-"+arch.NodeTarget+".tar.gz"), algo: download.SHA256, want: arch.NodeArchiveSHA256, mode: 0o600, owner: fsx.Current()},
	}
	for index, want := range wantCalls {
		if dl.calls[index] != want {
			t.Fatalf("artifact request %d differed from the expected pinned request", index)
		}
	}
	for path, want := range map[string][]byte{
		filepath.Join(installer.uvBinDir(), "uv"):     uvBinary,
		filepath.Join(installer.uvBinDir(), "uvx"):    uvxBinary,
		filepath.Join(installer.nodeBinDir(), "node"): []byte("fixture node executable"),
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != string(want) {
			t.Fatalf("verified artifact output was not written")
		}
	}
}

func TestMacInstallerCheckoutOnlyRunsPinnedRepositoryStageAndPreservesOtherHomes(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	externalHermes := filepath.Join(home, ".hermes")
	if err := os.MkdirAll(externalHermes, 0o700); err != nil {
		t.Fatal(err)
	}
	externalConfig := filepath.Join(externalHermes, "config.yaml")
	writeMacFixture(t, externalConfig, "external-hermes-data", 0o600)
	if err := os.MkdirAll(paths.RuntimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	installedData := filepath.Join(paths.RuntimeRoot, "preserve-me")
	writeMacFixture(t, installedData, "existing-installed-data", 0o600)

	dl := &fixtureMacDownloader{files: map[string][]byte{pins.HermesInstallerURL: []byte("pinned installer fixture")}}
	stage := exec.Cmd{Path: "/bin/bash", Args: []string{
		paths.Installer, "--non-interactive", "--skip-setup", "--skip-browser", "--skip-computer-use",
		"--dir", paths.InstallDir, "--hermes-home", paths.RuntimeRoot,
		"--branch", pins.HermesInstallerBranch, "--commit", pins.HermesInstallerCommit,
		"--stage", "repository",
	}}
	runner := exectest.NewFake().
		On(stage.String(), exec.Result{}).
		On("/fixture/selected-git -C "+paths.InstallDir+" rev-parse HEAD", exec.Result{Stdout: "wrong-commit\n"})
	installer := &MacInstaller{Runner: runner, Download: dl, Paths: paths, Home: home, gitPath: "/fixture/selected-git"}

	err = installer.checkout(context.Background())
	if err == nil || !strings.Contains(err.Error(), "pinned commit") {
		t.Fatal("checkout with the wrong commit was accepted")
	}
	if len(dl.calls) != 1 || dl.calls[0].url != pins.HermesInstallerURL || dl.calls[0].dest != paths.Installer || dl.calls[0].algo != download.SHA256 || dl.calls[0].want != pins.HermesInstallerSHA256 || dl.calls[0].mode != 0o700 {
		t.Fatal("checkout did not request the pinned repository installer")
	}
	if !runner.Ran(stage.String()) {
		t.Fatal("the pinned repository stage was not run")
	}
	if len(runner.Calls) != 2 || strings.Contains(strings.Join(runner.Commands(), "\n"), "venv") || strings.Contains(strings.Join(runner.Commands(), "\n"), "sync") {
		t.Fatal("checkout ran work outside the repository stage and commit proof")
	}
	for path, want := range map[string]string{externalConfig: "external-hermes-data", installedData: "existing-installed-data"} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatal("wrong-commit checkout changed pre-existing user data")
		}
	}
}

func TestMacInstallerHealthyExistingVenvSkipsDependencyMutation(t *testing.T) {
	installer, runner, python := newMacVenvFixture(t, true)
	if err := installer.venv(context.Background(), python); err != nil {
		t.Fatalf("healthy environment should not need mutation: %v", err)
	}
	if !runner.Ran(filepath.Join(installer.uvBinDir(), "uv") + " sync --project " + installer.Paths.InstallDir + " --extra all --extra anthropic --locked --check") {
		t.Fatal("existing environment was not checked against the lock")
	}
	if runner.Ran(filepath.Join(installer.uvBinDir(), "uv") + " sync --project " + installer.Paths.InstallDir + " --extra all --extra anthropic --locked") {
		t.Fatal("healthy existing environment ran mutating sync")
	}
}

func TestMacInstallerPreservesActiveVenvWhenLockedDependenciesWouldChange(t *testing.T) {
	installer, runner, python := newMacVenvFixture(t, true)
	installer.PreserveExistingVenv = true
	venvSentinel := filepath.Join(filepath.Dir(installer.Paths.VenvBin), "preserve-me")
	writeMacFixture(t, venvSentinel, "existing-venv-data", 0o600)
	runner.On(filepath.Join(installer.uvBinDir(), "uv")+" sync --project "+installer.Paths.InstallDir+" --extra all --extra anthropic --locked --check", exec.Result{ExitCode: 1})
	err := installer.venv(context.Background(), python)
	if err == nil || !strings.Contains(err.Error(), "was preserved") {
		t.Fatal("dependency change was not refused for the existing venv")
	}
	if runner.Ran(filepath.Join(installer.uvBinDir(), "uv") + " sync --project " + installer.Paths.InstallDir + " --extra all --extra anthropic --locked") {
		t.Fatal("existing venv was destructively synchronized")
	}
	got, err := os.ReadFile(venvSentinel)
	if err != nil || string(got) != "existing-venv-data" {
		t.Fatal("existing venv data was changed")
	}
}

func TestMacInstallerRejectsManagedPythonOutsidePrivateRoot(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	outsidePython := filepath.Join(t.TempDir(), "python3.11")
	command := filepath.Join(paths.AppRoot, "uv", pins.UVVersion, "bin", "uv") + " python find --managed-python --no-python-downloads --no-project --resolve-links " + pins.PythonVersion
	runner := exectest.NewFake().On(command, exec.Result{Stdout: outsidePython + "\n"})
	installer := &MacInstaller{Runner: runner, Paths: paths, Home: home}
	if _, err := installer.installPython(context.Background()); err == nil || !strings.Contains(err.Error(), "outside its private root") {
		t.Fatal("external Python path was accepted")
	}
	if len(runner.Calls) != 1 {
		t.Fatal("untrusted Python path was executed")
	}
}

func TestMacInstallerProveRefusesUnexpectedHermesVersion(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(paths.VenvBin, "hermes") + " --version"
	runner := exectest.NewFake().On(command, exec.Result{Stdout: "hermes 0.0.0\n"})
	installer := &MacInstaller{Runner: runner, Paths: paths, Home: home}
	if err := installer.Prove(context.Background()); err == nil || !strings.Contains(err.Error(), "differs from the pin") {
		t.Fatal("unexpected Hermes version was accepted")
	}
}

func TestPrepareMacEnvPreservesBearerAndProviderEntriesOnReplay(t *testing.T) {
	paths := newMacPaths(t)
	token := strings.Repeat("a", 64)
	initial := "OPENAI_API_KEY=provider-value\nAPI_SERVER_KEY=" + token + "\nCUSTOM=value\n"
	writeMacFixture(t, filepath.Join(paths.RuntimeRoot, ".env"), initial, 0o600)
	writeMacFixture(t, paths.RuntimeEnv, RuntimeEnvContent(token), 0o600)

	changed, err := PrepareMacEnv(paths)
	if err != nil || !changed {
		t.Fatalf("first environment preparation was not recorded: changed=%v err=%v", changed, err)
	}
	first, err := os.ReadFile(filepath.Join(paths.RuntimeRoot, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"API_SERVER_KEY=" + token + "\n", "OPENAI_API_KEY=provider-value\n", "CUSTOM=value\n", "API_SERVER_ENABLED=true\n"} {
		if !strings.Contains(string(first), want) {
			t.Fatal("runtime environment lost its bearer or an unrelated provider setting")
		}
	}
	assertMacPrivateFile(t, filepath.Join(paths.RuntimeRoot, ".env"))
	assertMacPrivateFile(t, paths.RuntimeEnv)
	changed, err = PrepareMacEnv(paths)
	if err != nil || changed {
		t.Fatalf("environment replay should be unchanged: changed=%v err=%v", changed, err)
	}
	second, err := os.ReadFile(filepath.Join(paths.RuntimeRoot, ".env"))
	if err != nil || string(second) != string(first) {
		t.Fatal("environment replay changed an established configuration")
	}
}

func TestPrepareMacEnvDisagreementAndSymlinksFailClosed(t *testing.T) {
	t.Run("disagreeing bearer sources", func(t *testing.T) {
		paths := newMacPaths(t)
		rootEnv := "API_SERVER_KEY=" + strings.Repeat("a", 64) + "\nPROVIDER_KEY=preserve\n"
		shadow := RuntimeEnvContent(strings.Repeat("b", 64))
		writeMacFixture(t, filepath.Join(paths.RuntimeRoot, ".env"), rootEnv, 0o600)
		writeMacFixture(t, paths.RuntimeEnv, shadow, 0o600)
		changed, err := PrepareMacEnv(paths)
		if err == nil || changed {
			t.Fatal("disagreeing bearer sources were accepted")
		}
		gotRoot, rootErr := os.ReadFile(filepath.Join(paths.RuntimeRoot, ".env"))
		gotShadow, shadowErr := os.ReadFile(paths.RuntimeEnv)
		if rootErr != nil || shadowErr != nil || string(gotRoot) != rootEnv || string(gotShadow) != shadow {
			t.Fatal("disagreeing bearer sources were modified")
		}
	})
	t.Run("root environment symlink", func(t *testing.T) {
		paths := newMacPaths(t)
		target := filepath.Join(t.TempDir(), "outside.env")
		content := "API_SERVER_KEY=" + strings.Repeat("c", 64) + "\n"
		writeMacFixture(t, target, content, 0o600)
		if err := os.Symlink(target, filepath.Join(paths.RuntimeRoot, ".env")); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareMacEnv(paths); err == nil {
			t.Fatal("root environment symlink was accepted")
		}
		got, err := os.ReadFile(target)
		if err != nil || string(got) != content {
			t.Fatal("symlink target was changed")
		}
	})
	t.Run("runtime shadow symlink", func(t *testing.T) {
		paths := newMacPaths(t)
		target := filepath.Join(t.TempDir(), "runtime.env")
		content := RuntimeEnvContent(strings.Repeat("d", 64))
		writeMacFixture(t, target, content, 0o600)
		rootEnv := "API_SERVER_KEY=" + strings.Repeat("d", 64) + "\n"
		writeMacFixture(t, filepath.Join(paths.RuntimeRoot, ".env"), rootEnv, 0o600)
		if err := os.Symlink(target, paths.RuntimeEnv); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareMacEnv(paths); err == nil {
			t.Fatal("runtime shadow symlink was accepted")
		}
		got, err := os.ReadFile(target)
		if err != nil || string(got) != content {
			t.Fatal("runtime shadow symlink target was changed")
		}
	})
}

func TestMacInstallerConfigureSkipsMatchingReadbackAndRequiresProofAfterSet(t *testing.T) {
	t.Run("matching settings are unchanged", func(t *testing.T) {
		installer, fake := newMacConfigFixture(t)
		for _, setting := range SecurityDefaults {
			fake.On(installer.Command("hermes", "config", "get", setting.Key).String(), exec.Result{Stdout: setting.Value + "\n"})
		}
		changed, err := installer.Configure(context.Background())
		if err != nil || changed {
			t.Fatalf("matching settings should be unchanged: changed=%v err=%v", changed, err)
		}
		for _, call := range fake.Calls {
			if len(call.Args) < 3 || call.Args[0] != "config" || call.Args[1] != "get" {
				t.Fatal("matching settings triggered a write")
			}
		}
	})
	t.Run("exit zero set requires exact readback", func(t *testing.T) {
		installer, fake := newMacConfigFixture(t)
		setting := SecurityDefaults[0]
		get := installer.Command("hermes", "config", "get", setting.Key).String()
		set := installer.Command("hermes", "config", "set", setting.Key, setting.Value).String()
		fake.OnSequence(get, exec.Result{Stdout: "unsafe\n"}, exec.Result{Stdout: "still-unsafe\n"})
		fake.On(set, exec.Result{})
		changed, err := installer.Configure(context.Background())
		if err == nil || changed {
			t.Fatal("successful command exit without matching readback was reported as success")
		}
		if !fake.Ran(set) {
			t.Fatal("misconfigured setting was not attempted")
		}
	})
}

func newMacPaths(t *testing.T) layout.MacRuntimePaths {
	t.Helper()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.RuntimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	return paths
}

func newMacVenvFixture(t *testing.T, healthy bool) (*MacInstaller, *exectest.Fake, string) {
	t.Helper()
	paths := newMacPaths(t)
	if err := os.MkdirAll(filepath.Dir(paths.VenvBin), 0o700); err != nil {
		t.Fatal(err)
	}
	python := filepath.Join(paths.AppRoot, "python", "cpython-3.14.7", "bin", "python3.14")
	fake := exectest.NewFake().OnPrefix(python+" -c "+lockValidator, exec.Result{}).
		On(filepath.Join(paths.VenvBin, "python")+" -c import platform; print(platform.python_version())", exec.Result{Stdout: pins.PythonVersion + "\n"})
	if healthy {
		fake.On(filepath.Join(paths.AppRoot, "uv", pins.UVVersion, "bin", "uv")+" sync --project "+paths.InstallDir+" --extra all --extra anthropic --locked --check", exec.Result{})
	}
	return &MacInstaller{Runner: fake, Paths: paths, Home: filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(paths.AppRoot))))}, fake, python
}

func newMacConfigFixture(t *testing.T) (*MacInstaller, *exectest.Fake) {
	t.Helper()
	paths := newMacPaths(t)
	fake := exectest.NewFake()
	return &MacInstaller{Runner: fake, Paths: paths}, fake
}

func writeMacFixture(t *testing.T, path, value string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsx.WriteAtomic(path, []byte(value), mode, fsx.Current()); err != nil {
		t.Fatal(err)
	}
}

func writeExecutableFixture(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func assertMacPrivateFile(t *testing.T, path string) {
	t.Helper()
	if _, err := fsx.ReadRegular(path, 0o600, fsx.Current()); err != nil {
		t.Fatalf("private macOS runtime file proof failed: %v", err)
	}
}

func fixtureSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
