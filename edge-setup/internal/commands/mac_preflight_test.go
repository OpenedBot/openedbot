package commands

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type macPreflightFixture struct {
	home    string
	paths   layout.MacRuntimePaths
	gitRoot string
	gitPath string
	runner  *exectest.Fake
}

func newMacPreflightFixture(t *testing.T) *macPreflightFixture {
	t.Helper()
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS runtime paths")
	}
	gitRoot := filepath.Join(home, "DeveloperTools")
	gitPath := filepath.Join(gitRoot, "usr", "bin", "git")
	if err := os.MkdirAll(filepath.Dir(gitPath), 0o700); err != nil {
		t.Fatal("could not create temporary developer tools fixture")
	}
	if err := os.WriteFile(gitPath, []byte("fixture Git executable, never launched"), 0o600); err != nil {
		t.Fatal("could not create inert Git fixture")
	}
	if err := os.Chmod(gitPath, 0o755); err != nil {
		t.Fatal("could not mark inert Git fixture executable")
	}
	runner := exectest.NewFake()
	runner.On("/bin/launchctl print gui/501", exec.Result{})
	runner.On("/usr/bin/xcode-select --print-path", exec.Result{Stdout: gitRoot + "\n"})
	runner.On(gitPath+" --version", exec.Result{Stdout: "git version 2.46.0\n"})
	return &macPreflightFixture{home: home, paths: paths, gitRoot: gitRoot, gitPath: gitPath, runner: runner}
}

func macPreflightHasReason(result macPreflight, text string) bool {
	for _, reason := range result.Reasons {
		if reason == text {
			return true
		}
	}
	return false
}

func TestCollectMacPreflightReportsPinnedSupportedArchitectureAndUserChecks(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		t.Run(arch, func(t *testing.T) {
			f := newMacPreflightFixture(t)
			result, err := collectMacPreflightForUID(context.Background(), f.home, arch, f.runner, 501)
			if err != nil {
				t.Fatal("fake macOS preflight failed")
			}
			if result.OperatingSystem != "darwin" || result.Architecture != arch || result.UserID != 501 || !result.Supported || !result.Ready {
				t.Fatal("preflight did not report a ready supported macOS user runtime")
			}
			for _, check := range []string{"architecture", "user", "gui_domain", "git"} {
				if result.Checks[check] != true {
					t.Fatalf("preflight check %q was not proven", check)
				}
			}
			if len(result.Reasons) != 0 || result.Paths.RuntimeRoot != f.paths.RuntimeRoot || result.Paths.InstallDir != f.paths.InstallDir {
				t.Fatal("ready preflight did not report only non-secret managed runtime paths")
			}
			if len(f.runner.Calls) != 3 {
				t.Fatalf("preflight executed %d fake checks, want launchctl, xcode-select, and selected Git", len(f.runner.Calls))
			}
			for i, call := range f.runner.Calls {
				if call.Timeout != 10*time.Second {
					t.Fatal("macOS preflight prerequisite command is not deadline-bounded")
				}
				if i == 0 && (call.Path != "/bin/launchctl" || strings.Join(call.Args, " ") != "print gui/501") {
					t.Fatal("GUI domain check did not use the user launchctl target")
				}
				if i == 1 && (call.Path != "/usr/bin/xcode-select" || strings.Join(call.Args, " ") != "--print-path") {
					t.Fatal("developer tools check did not use xcode-select read-only mode")
				}
				if i == 2 && (call.Path != f.gitPath || strings.Join(call.Args, " ") != "--version") {
					t.Fatal("Git version check did not use the selected tools Git path")
				}
			}
			if _, err := os.Lstat(f.paths.AppRoot); !os.IsNotExist(err) {
				t.Fatal("read-only preflight created the managed runtime")
			}
			encoded, err := json.Marshal(result)
			if err != nil || strings.Contains(string(encoded), "API_SERVER_KEY") {
				t.Fatal("preflight JSON contains an invalid or secret-bearing result")
			}
		})
	}
}

func TestCollectMacPreflightRefusesUnknownArchitectureAndRootUser(t *testing.T) {
	t.Run("unknown architecture", func(t *testing.T) {
		f := newMacPreflightFixture(t)
		result, err := collectMacPreflightForUID(context.Background(), f.home, "riscv64", f.runner, 501)
		if err != nil || result.Supported || result.Ready || result.Checks["architecture"] || !result.Checks["gui_domain"] || !result.Checks["git"] {
			t.Fatal("unknown architecture was treated as supported or skipped safe prerequisite checks")
		}
		if !macPreflightHasReason(result, "this macOS architecture has no verified artifacts") {
			t.Fatal("unknown architecture did not produce its generic refusal reason")
		}
	})

	t.Run("root is not a logged-in user", func(t *testing.T) {
		f := newMacPreflightFixture(t)
		result, err := collectMacPreflightForUID(context.Background(), f.home, "arm64", f.runner, 0)
		if err != nil || result.Ready || result.Checks["user"] || result.Checks["gui_domain"] || !result.Checks["git"] {
			t.Fatal("root was accepted as a macOS logged-in desktop user or caused a GUI-domain probe")
		}
		if !macPreflightHasReason(result, "run as the logged-in macOS user, without sudo") {
			t.Fatal("root-user refusal reason was not reported")
		}
		if len(f.runner.Calls) != 2 || f.runner.Calls[0].Path != "/usr/bin/xcode-select" {
			t.Fatal("root preflight queried launchctl or skipped developer-tools verification")
		}
	})
}

func TestCollectMacPreflightFailsClosedOnUnknownGUIAndGitChecks(t *testing.T) {
	t.Run("GUI success with diagnostics is unverified", func(t *testing.T) {
		f := newMacPreflightFixture(t)
		f.runner.On("/bin/launchctl print gui/501", exec.Result{Stderr: "fixture-private-diagnostic"})
		result, err := collectMacPreflightForUID(context.Background(), f.home, "arm64", f.runner, 501)
		if err != nil || result.Ready || result.Checks["gui_domain"] {
			t.Fatal("GUI success with diagnostics was accepted as a proved domain")
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "fixture-private-diagnostic") {
			t.Fatal("GUI diagnostic escaped into the result")
		}
	})

	t.Run("GUI domain unknown", func(t *testing.T) {
		f := newMacPreflightFixture(t)
		secret := "fixture-launchctl-error-transcript"
		f.runner.On("/bin/launchctl print gui/501", exec.Result{ExitCode: 1, Stderr: secret})
		result, err := collectMacPreflightForUID(context.Background(), f.home, "arm64", f.runner, 501)
		if err != nil || result.Ready || result.Checks["gui_domain"] || !result.Checks["git"] {
			t.Fatal("unknown user GUI domain was not reported as an unproven prerequisite")
		}
		if !macPreflightHasReason(result, "the user's GUI launchd domain could not be verified") {
			t.Fatal("GUI domain failure did not use a generic reason")
		}
		for _, reason := range result.Reasons {
			if strings.Contains(reason, secret) {
				t.Fatal("launchctl stderr escaped into preflight output")
			}
		}
	})

	t.Run("selected Git unknown", func(t *testing.T) {
		f := newMacPreflightFixture(t)
		secret := "fixture-git-error-transcript"
		f.runner.On(f.gitPath+" --version", exec.Result{ExitCode: 1, Stderr: secret})
		result, err := collectMacPreflightForUID(context.Background(), f.home, "arm64", f.runner, 501)
		if err != nil || result.Ready || !result.Checks["gui_domain"] || result.Checks["git"] {
			t.Fatal("unverified selected-tools Git was treated as ready")
		}
		if !macPreflightHasReason(result, "selected developer tools Git could not be verified") {
			t.Fatal("Git failure did not use a generic reason")
		}
		for _, reason := range result.Reasons {
			if strings.Contains(reason, secret) {
				t.Fatal("Git stderr escaped into preflight output")
			}
		}
	})
}

func TestCollectMacPreflightUsesCurrentProcessUser(t *testing.T) {
	f := newMacPreflightFixture(t)
	result, err := collectMacPreflight(context.Background(), f.home, "amd64", f.runner)
	if err != nil || result.UserID != os.Geteuid() || result.Checks["user"] != (os.Geteuid() > 0) {
		t.Fatal("preflight did not derive its user check from the current process identity")
	}
}

func TestMacPlanLinesDescribePinnedPrivateRuntimeWithoutLinuxProvisioning(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal("could not derive temporary managed macOS runtime paths")
	}
	text := strings.Join(macPlanLines(paths), "\n")
	for _, want := range []string{
		"Inspect user GUI and developer Git",
		"Prepare pinned private runtime",
		"Start gateway and operator agents",
		"Prove health, policy, capabilities",
		"reachability connector (outbound only)",
		"user runtime " + paths.RuntimeRoot,
		"versioned checkout " + paths.InstallDir,
		"Hermes " + pins.HermesVersion,
		pins.HermesInstallerCommit[:12],
		"uv " + pins.UVVersion,
		"Python " + pins.PythonVersion,
		"Node " + pins.NodeVersion,
		"com.openhermesbot.edge-setup.gateway",
		"com.openhermesbot.edge-setup.operator",
		"com.openhermesbot.edge-setup.connector.<instance>",
		"personal ~/.hermes",
		"writes " + paths.ToolConfig,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("macOS plan omitted %q", want)
		}
	}
	for _, linuxStep := range []string{"systemctl", "apt-get", "P0 ", "P1 ", "/etc/hermes"} {
		if strings.Contains(text, linuxStep) {
			t.Errorf("macOS plan included Linux provisioning step %q", linuxStep)
		}
	}
}
