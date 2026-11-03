package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// fakeHermes writes a minimal hermes_cli package: the config module resolves
// HERMES_HOME/config.yaml (or `resolved` when set), and the toolset change
// records each call; save_config writes the config as JSON next to it.
func fakeHermes(t *testing.T, resolved string) string {
	t.Helper()
	dir := t.TempDir()
	pkg := filepath.Join(dir, "hermes_cli")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"__init__.py": "",
		"config.py": `import json, os
RESOLVED = ` + "'" + resolved + "'" + `
def get_config_path():
    return RESOLVED or os.path.join(os.environ["HERMES_HOME"], "config.yaml")
def load_config():
    return {"platform_toolsets": {"api_server": ["web"]}}
def save_config(config):
    with open(os.path.join(os.environ["HERMES_HOME"], "saved.json"), "w") as handle:
        json.dump(config, handle)
`,
		"tools_config_mcp.py": `def _apply_toolset_change(config, platform, names, action):
    current = set(config["platform_toolsets"][platform])
    current = current - set(names) if action == "disable" else current | set(names)
    config["platform_toolsets"][platform] = sorted(current)
    config.setdefault("calls", []).append([action] + list(names))
`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(pkg, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runToolsetsProgram(t *testing.T, root, pythonPath string, enable, disable string) error {
	t.Helper()
	cmd := osexec.Command("python3", "-")
	cmd.Stdin = bytes.NewReader(profileToolsetsProgram)
	cmd.Env = append(os.Environ(),
		"PYTHONPATH="+pythonPath,
		"OPENEDBOT_TOOLSETS_ROOT="+root,
		"OPENEDBOT_TOOLSETS_PROFILE=scout",
		"OPENEDBOT_TOOLSETS_ENABLE="+enable,
		"OPENEDBOT_TOOLSETS_DISABLE="+disable,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return errors.New(err.Error() + ": " + stderr.String())
	}
	return nil
}

func profileFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, home
}

func TestProfileToolsetsProgramAppliesBothDirectionsInTheProfileHome(t *testing.T) {
	if _, err := osexec.LookPath("python3"); err != nil {
		t.Skip("python3 is not installed")
	}
	root, home := profileFixture(t)
	if err := runToolsetsProgram(t, root, fakeHermes(t, ""), "file,terminal", "web"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "saved.json"))
	if err != nil {
		t.Fatalf("the profile's configuration was not saved in its home: %v", err)
	}
	var saved struct {
		PlatformToolsets map[string][]string `json:"platform_toolsets"`
		Calls            [][]string          `json:"calls"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(saved.PlatformToolsets["api_server"], []string{"file", "terminal"}) ||
		len(saved.Calls) != 2 || saved.Calls[0][0] != "enable" || saved.Calls[1][0] != "disable" {
		t.Fatalf("saved %s", raw)
	}
	if _, err := os.Stat(filepath.Join(root, "saved.json")); err == nil {
		t.Fatal("the root's configuration was written")
	}
}

func TestProfileToolsetsProgramRefusesAnotherConfigurationFile(t *testing.T) {
	if _, err := osexec.LookPath("python3"); err != nil {
		t.Skip("python3 is not installed")
	}
	root, home := profileFixture(t)
	err := runToolsetsProgram(t, root, fakeHermes(t, filepath.Join(root, "config.yaml")), "file", "")
	if err == nil || !strings.Contains(err.Error(), "another configuration file") {
		t.Fatalf("a root-resolved configuration was not refused: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(home, "saved.json")); statErr == nil {
		t.Fatal("a configuration was saved after the refusal")
	}
}

func TestProfileToolsetsApplierScopesTheProgramToTheProfile(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("python -", exec.Result{})
	apply := profileToolsetsApplier(fake, "/srv/hermes/data", func(args ...string) exec.Cmd {
		return exec.Cmd{Path: "python", Args: args}
	})
	if err := apply(context.Background(), "scout", []string{"file", "web"}, []string{"browser"}); err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls %v", fake.Calls)
	}
	call := fake.Calls[0]
	for _, want := range []string{"OPENEDBOT_TOOLSETS_ROOT=/srv/hermes/data", "OPENEDBOT_TOOLSETS_PROFILE=scout", "OPENEDBOT_TOOLSETS_ENABLE=file,web", "OPENEDBOT_TOOLSETS_DISABLE=browser"} {
		if !slices.Contains(call.Env, want) {
			t.Fatalf("env %v lacks %s", call.Env, want)
		}
	}
	if !bytes.HasPrefix(call.Stdin, profileToolsetsProgram) {
		t.Fatal("the program did not travel on stdin")
	}
	for _, bad := range [][2]any{{"default", []string{"web"}}, {"scout", []string{"web,browser"}}, {"../x", []string{"web"}}} {
		if err := apply(context.Background(), bad[0].(string), bad[1].([]string), nil); err == nil {
			t.Fatalf("%v was accepted", bad)
		}
	}
	if len(fake.Calls) != 1 {
		t.Fatal("a refused batch reached the runner")
	}
}

func TestProfileToolsetsBatchUsesOneProcessAndFallsBackOnTheCLI(t *testing.T) {
	for _, failing := range []bool{false, true} {
		fake := exectest.NewFake()
		fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
		var applied [][]string
		s := &Server{
			Runner: fake,
			Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
				if verb == "toolsets" {
					return []byte(`{"platform":"api_server","settable":["browser","web"]}`), nil
				}
				return []byte(`{"error":{"code":"HOST_FAILED","message":"no reply"}}`), nil
			},
			Inventory: func(context.Context) ([]byte, error) { return []byte(`{"data":[]}`), nil },
			ProfileInventory: func(context.Context, string) ([]byte, error) {
				return []byte(`{"data":[{"name":"web","enabled":true},{"name":"browser","enabled":false}]}`), nil
			},
			ProfileToolsets: func(_ context.Context, profile string, enable, disable []string) error {
				applied = append(applied, append(append([]string{profile}, enable...), disable...))
				if failing {
					return errors.New("no upstream function")
				}
				return nil
			},
		}
		srv := httptest.NewServer(s.Handler())
		status, out := call(t, srv, "POST", "/profiles/scout/toolsets", `{"toolsets":{"web":true,"browser":false}}`)
		srv.Close()
		if status != 200 || len(applied) != 1 || !slices.Equal(applied[0], []string{"scout", "web", "browser"}) {
			t.Fatalf("failing=%v: %d %v %v", failing, status, out, applied)
		}
		if !failing && len(fake.Calls) != 0 {
			t.Fatalf("the in-process write still spawned the CLI: %v", fake.Commands())
		}
		if failing && len(fake.Calls) != 2 {
			t.Fatalf("a failed in-process write did not fall back on the CLI: %v", fake.Commands())
		}
	}
}
