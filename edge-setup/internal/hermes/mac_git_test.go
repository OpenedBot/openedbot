package hermes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type macGitFixture struct {
	root string
	path string
}

func newMacGitFixture(t *testing.T) macGitFixture {
	t.Helper()
	root := filepath.Join(t.TempDir(), "CommandLineTools")
	path := filepath.Join(root, "usr", "bin", "git")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal("could not create temporary developer tools fixture")
	}
	if err := os.WriteFile(path, []byte("inert Git fixture, never launched"), 0o600); err != nil {
		t.Fatal("could not create inert Git fixture")
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal("could not mark inert Git fixture executable")
	}
	return macGitFixture{root: root, path: path}
}

func macGitRunner(fixture macGitFixture) *exectest.Fake {
	return exectest.NewFake().
		On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: fixture.root + "\n"}).
		On(fixture.path+" --version", exec.Result{Stdout: "git version 2.46.0\n"})
}

func TestMacGitRequiresSelectedDeveloperToolsWithoutLeakingDiagnostics(t *testing.T) {
	t.Run("xcode-select command fails", func(t *testing.T) {
		secret := "fixture-xcode-select-transcript-secret"
		fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{ExitCode: 1, Stderr: secret})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "select installed Xcode command-line tools before preparing this runtime" || strings.Contains(err.Error(), secret) {
			t.Fatal("xcode-select diagnostics escaped or missing developer tools were accepted")
		}
		if len(fake.Calls) != 1 || fake.Calls[0].Path != "/usr/bin/xcode-select" {
			t.Fatal("MacGit called a Git binary after xcode-select failed")
		}
	})

	t.Run("selected tools path is absent", func(t *testing.T) {
		fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: "\n"})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "selected developer tools path is invalid" {
			t.Fatal("empty selected developer tools path was accepted")
		}
		if len(fake.Calls) != 1 {
			t.Fatal("invalid developer tools path reached Git")
		}
	})

	t.Run("selected tools path is relative", func(t *testing.T) {
		fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: "Developer/CommandLineTools\n"})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "selected developer tools path is invalid" || len(fake.Calls) != 1 {
			t.Fatal("relative developer tools path was accepted or reached Git")
		}
	})
}

func TestMacGitRequiresExecutableSDKGitAndVerifiesItsVersion(t *testing.T) {
	t.Run("Git missing", func(t *testing.T) {
		root := t.TempDir()
		fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: root + "\n"})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "selected developer tools do not contain an executable Git" || len(fake.Calls) != 1 {
			t.Fatal("missing selected-tools Git was accepted or invoked")
		}
	})

	t.Run("Git not executable", func(t *testing.T) {
		root := t.TempDir()
		git := filepath.Join(root, "usr", "bin", "git")
		if err := os.MkdirAll(filepath.Dir(git), 0o700); err != nil {
			t.Fatal("could not create temporary developer tools directory")
		}
		if err := os.WriteFile(git, []byte("inert fixture"), 0o600); err != nil {
			t.Fatal("could not create non-executable Git fixture")
		}
		fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: root + "\n"})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "selected developer tools do not contain an executable Git" || len(fake.Calls) != 1 {
			t.Fatal("non-executable selected-tools Git was accepted or invoked")
		}
	})

	t.Run("bad Git version transcript", func(t *testing.T) {
		fixture := newMacGitFixture(t)
		secret := "fixture-git-version-transcript-secret"
		fake := exectest.NewFake().
			On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: fixture.root + "\n"}).
			On(fixture.path+" --version", exec.Result{ExitCode: 1, Stderr: secret})
		_, err := MacGit(context.Background(), fake)
		if err == nil || err.Error() != "selected developer tools Git could not be verified" || strings.Contains(err.Error(), secret) {
			t.Fatal("Git version transcript escaped or failed Git was accepted")
		}
		if len(fake.Calls) != 2 || fake.Calls[1].Path != fixture.path {
			t.Fatal("Git verification did not use the selected SDK binary")
		}
	})

	t.Run("valid selected SDK Git", func(t *testing.T) {
		fixture := newMacGitFixture(t)
		fake := macGitRunner(fixture)
		got, err := MacGit(context.Background(), fake)
		if err != nil || got != fixture.path {
			t.Fatal("MacGit did not return the verified selected-tools binary")
		}
		if len(fake.Calls) != 2 || fake.Calls[0].Path != "/usr/bin/xcode-select" || fake.Calls[1].Path != fixture.path || fake.Calls[1].Path == "/usr/bin/git" {
			t.Fatal("MacGit ran the system shim instead of the selected SDK Git")
		}
		for _, call := range fake.Calls {
			if call.Timeout != 10*time.Second {
				t.Fatal("MacGit prerequisite invocation is not bounded")
			}
		}
	})
}

type macGitDownloadFake struct {
	installer *MacInstaller
	wantGit   string
	calls     int
	pathSeen  bool
}

func (f *macGitDownloadFake) Fetch(context.Context, string, string, download.Algorithm, string, os.FileMode, fsx.Owner) error {
	f.calls++
	f.pathSeen = f.installer.gitPath == f.wantGit && strings.Contains(strings.Join(f.installer.env(), "\n"), "PATH="+f.installer.Paths.VenvBin+":"+f.installer.uvBinDir()+":"+f.installer.nodeBinDir()+":"+filepath.Dir(f.wantGit)+":")
	return errors.New("stop after checking the fake downloader boundary")
}

func TestMacInstallerRefusesMissingDeveloperToolsBeforeFilesystemOrDownloads(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS runtime paths")
	}
	fake := exectest.NewFake().On("/usr/bin/xcode-select --print-path", exec.Result{ExitCode: 1, Stderr: "fixture transcript"})
	downloads := &macGitDownloadFake{}
	installer := &MacInstaller{Runner: fake, Download: downloads, Paths: paths, Home: home, Arch: pins.MacArches["arm64"]}
	downloads.installer = installer
	err = installer.Prepare(context.Background())
	if err == nil || err.Error() != "select installed Xcode command-line tools before preparing this runtime" {
		t.Fatal("MacInstaller proceeded without selected developer tools")
	}
	if downloads.calls != 0 || len(fake.Calls) != 1 {
		t.Fatal("MacInstaller downloaded or probed Git after xcode-select failed")
	}
	for _, path := range []string{paths.AppRoot, paths.RuntimeRoot, filepath.Dir(paths.InstallDir)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("MacInstaller created runtime directories before developer tools were verified")
		}
	}
}

func TestMacInstallerUsesVerifiedSDKGitPathForPATHAndCheckoutProof(t *testing.T) {
	fixture := newMacGitFixture(t)
	fake := macGitRunner(fixture)
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS runtime paths")
	}
	downloads := &macGitDownloadFake{wantGit: fixture.path}
	installer := &MacInstaller{Runner: fake, Download: downloads, Paths: paths, Home: home, Arch: pins.MacArches["arm64"]}
	downloads.installer = installer
	if err := installer.Prepare(context.Background()); err == nil || err.Error() != "pinned macOS uv download failed" {
		t.Fatal("fake download stop was not reached after selected Git verification")
	}
	if downloads.calls != 1 || !downloads.pathSeen || installer.gitPath != fixture.path {
		t.Fatal("MacInstaller did not retain the verified Git path in its private PATH")
	}
	if len(fake.Calls) != 2 || fake.Calls[1].Path != fixture.path {
		t.Fatal("MacInstaller did not verify the selected Git version before preparation")
	}

	checkoutDir := filepath.Join(t.TempDir(), "checkout")
	if err := os.MkdirAll(filepath.Join(checkoutDir, ".git"), 0o700); err != nil {
		t.Fatal("could not create inert checkout fixture")
	}
	installer.Paths.InstallDir = checkoutDir
	commit := exec.Cmd{Path: fixture.path, Args: []string{"-C", checkoutDir, "rev-parse", "HEAD"}}
	clean := exec.Cmd{Path: fixture.path, Args: []string{"-C", checkoutDir, "status", "--porcelain", "--untracked-files=normal"}}
	fake.On(commit.String(), exec.Result{Stdout: pins.HermesInstallerCommit + "\n"})
	fake.On(clean.String(), exec.Result{Stdout: ""})
	if err := installer.checkout(context.Background()); err != nil {
		t.Fatal("checkout proof did not use the verified selected SDK Git")
	}
	if len(fake.Calls) != 4 || fake.Calls[2].Path != fixture.path || fake.Calls[3].Path != fixture.path {
		t.Fatal("commit and clean-checkout proofs did not call the selected SDK Git directly")
	}
}
