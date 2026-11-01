package hermes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

func TestGatewayEnvironmentSupportsFreshAndExistingMultiplexedRuntime(t *testing.T) {
	key := strings.Repeat("ab", 32)
	for _, tc := range []struct {
		name, runtime, profile string
	}{
		{name: "fresh"},
		{name: "upgrade-0205", runtime: RuntimeEnvContent(key)},
		{name: "repair-stale-profile-key", runtime: RuntimeEnvContent(key), profile: "API_SERVER_KEY=stale\n"},
		{name: "recover-profile-only", profile: "API_SERVER_KEY=" + key + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "runtime.env")
			profile := filepath.Join(root, ".env")
			if tc.runtime != "" {
				writeStoreFile(t, path, tc.runtime, fsx.Current())
			}
			const unrelated = "# provider settings\nOPENAI_API_KEY=example-provider-key\nCUSTOM=\"keep # this\"\n"
			if tc.name != "fresh" {
				writeStoreFile(t, profile, unrelated+tc.profile, fsx.Current())
			}
			changed, err := writeRuntimeEnvAt(path, fsx.Current(), nil)
			if err != nil || !changed {
				t.Fatalf("initial reconciliation: changed=%v err=%v", changed, err)
			}
			runtime, err := fsx.ReadRegular(path, 0o600, fsx.Current())
			if err != nil {
				t.Fatal(err)
			}
			gotKey := ReadToken(string(runtime))
			if !tokenRe.MatchString(gotKey) || tc.name != "fresh" && gotKey != key {
				t.Fatal("gateway bearer was invalid or rotated")
			}
			data, err := fsx.ReadRegular(profile, 0o600, fsx.Current())
			if err != nil {
				t.Fatal(err)
			}
			values := parseDotEnv(data)
			for k, v := range parseDotEnv(runtime) {
				if values[k] != v {
					t.Fatalf("profile scope disagrees on %s", k)
				}
			}
			if tc.name != "fresh" && !strings.Contains(string(data), unrelated) {
				t.Fatal("unrelated provider configuration was modified")
			}
			changed, err = writeRuntimeEnvAt(path, fsx.Current(), nil)
			if err != nil || changed {
				t.Fatalf("replay must not request a restart: changed=%v err=%v", changed, err)
			}
		})
	}
}

func TestGatewayEnvironmentRefusesSymlinksAndInvalidBearer(t *testing.T) {
	for _, name := range []string{"runtime.env", ".env"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			outside := filepath.Join(t.TempDir(), "secret")
			const original = "KEEP=1\n"
			writeStoreFile(t, outside, original, fsx.Current())
			if err := os.Symlink(outside, filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			if _, err := writeRuntimeEnvAt(filepath.Join(root, "runtime.env"), fsx.Current(), nil); err == nil {
				t.Fatal("symlink accepted")
			}
			data, err := os.ReadFile(outside)
			if err != nil || string(data) != original {
				t.Fatal("symlink target changed")
			}
		})
		t.Run(name+"-invalid-key", func(t *testing.T) {
			root := t.TempDir()
			writeStoreFile(t, filepath.Join(root, name), "API_SERVER_KEY=short\n", fsx.Current())
			if _, err := writeRuntimeEnvAt(filepath.Join(root, "runtime.env"), fsx.Current(), nil); err == nil {
				t.Fatal("invalid established bearer accepted")
			}
		})
	}
}

func TestInstallStampExclusionSurvivesOlderGitignore(t *testing.T) {
	root := t.TempDir()
	info := filepath.Join(root, ".git", "info")
	if err := os.MkdirAll(info, 0o755); err != nil {
		t.Fatal(err)
	}
	exclude := filepath.Join(info, "exclude")
	const original = "# existing exclusion\n/venv/"
	writeStoreFile(t, exclude, original, fsx.Current())
	for range 2 {
		if err := writeInstallStamp(filepath.Join(root, "install-stamp.json"), fsx.Current()); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(exclude)
	if err != nil || string(data) != original+"\n/install-stamp.json\n" {
		t.Fatalf("exclusion must preserve existing rules and match only root stamp: %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".gitignore")); !os.IsNotExist(err) {
		t.Fatal("versioned ignore rules must not be modified")
	}
}

func TestInstallStampExclusionRefusesSymlinks(t *testing.T) {
	for _, name := range []string{".git", ".git/info", ".git/info/exclude"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, name)
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), target); err != nil {
				t.Fatal(err)
			}
			if err := ignoreInstallStamp(root, fsx.Current()); err == nil {
				t.Fatal("symlink accepted")
			}
		})
	}
}

func TestRepositoryStageRunsAfterOldDirtyCheckoutWasStopped(t *testing.T) {
	for _, needed := range []bool{true, false} {
		fake := exectest.NewFake().OnPrefix("/bin/bash "+layout.InstallerPath+" ", exec.Result{})
		i := &Installer{Runner: fake, stoppedGateway: true}
		if err := i.installRepository(context.Background(), needed, true); err != nil {
			t.Fatal(err)
		}
		if !needed {
			if len(fake.Calls) != 0 {
				t.Fatal("unchanged checkout ran the installer")
			}
			continue
		}
		if len(fake.Calls) != 1 {
			t.Fatal("dirty old checkout did not run the repository stage exactly once")
		}
		command := fake.Calls[0].String()
		if !strings.Contains(command, "--commit "+pins.HermesInstallerCommit+" --stage repository") {
			t.Fatal("repository stage did not select the pinned commit")
		}
	}
}
