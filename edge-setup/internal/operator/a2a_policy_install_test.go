package operator

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestA2ACompanionInstallBindsRootAndProfilesWithoutConfigChanges(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "openedbot-client")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{root, profile} {
		if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("fixture: preserved\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	orphan := filepath.Join(root, "profiles", "deleted-profile", "logs")
	if err := os.MkdirAll(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := InstallA2APolicyFiles(root, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{root, profile} {
		plugin := filepath.Join(home, "plugins", "openedbot_a2a_policy")
		marker, err := os.ReadFile(filepath.Join(plugin, "runtime-home"))
		if err != nil || string(marker) != root+"\n" {
			t.Fatal("profile guard was not bound to its runtime root")
		}
		for _, name := range []string{"plugin.yaml", "__init__.py", "policy.py", "snapshot.py", "runtime_scope.py", "runtime-home"} {
			if valid, err := fsx.RequireRegular(filepath.Join(plugin, name), 0o600, fsx.Current()); err != nil || !valid {
				t.Fatal("companion installation did not preserve private owner files")
			}
		}
		cfg, _ := os.ReadFile(filepath.Join(home, "config.yaml"))
		if string(cfg) != "fixture: preserved\n" {
			t.Fatal("file materialization rewrote unrelated configuration")
		}
	}
	if _, err := os.Stat(filepath.Join(root, "hooks", "openedbot_a2a_policy", "handler.py")); err != nil {
		t.Fatal("root gateway startup hook is absent")
	}
	for _, hook := range []string{"openedbot_backend_probe", "openedbot_prompt_cache_ttl"} {
		for _, name := range []string{"HOOK.yaml", "handler.py"} {
			if _, err := os.Stat(filepath.Join(root, "hooks", hook, name)); err != nil {
				t.Fatal("root gateway hook is absent: " + hook + "/" + name)
			}
		}
		if _, err := os.Stat(filepath.Join(root, "hooks", hook, "test_handler.py")); !os.IsNotExist(err) {
			t.Fatal("a hook test was shipped to the host: " + hook)
		}
	}
	if _, err := os.Stat(filepath.Join(profile, "hooks")); !os.IsNotExist(err) {
		t.Fatal("a named profile received a second gateway startup hook")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(orphan), "plugins")); !os.IsNotExist(err) {
		t.Fatal("deleted profile logs received companion files")
	}
}

func TestA2ACompanionInstallRefusesEscapeAndSymlink(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if installA2APolicyHome(root, outside, fsx.Current()) == nil {
		t.Fatal("unrelated home accepted")
	}
	if err := os.Symlink(outside, filepath.Join(root, "plugins")); err != nil {
		t.Fatal(err)
	}
	if InstallA2APolicyFiles(root, fsx.Current()) == nil {
		t.Fatal("symlink plugin root accepted")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("installation followed an external symlink")
	}
}
