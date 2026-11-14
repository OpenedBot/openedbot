package layout

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestMacNamespacesFollowTheRenameAndKeepTheLegacyRootReadable(t *testing.T) {
	home := "/Users/operator"
	current, err := MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	if current.AppRoot != "/Users/operator/Library/Application Support/app.openedbot.edge-setup" || current.Home != home || current.Namespace != MacCurrent {
		t.Fatalf("current root = %s", current.AppRoot)
	}
	legacy, err := MacRuntimeIn(MacLegacy, home)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.AppRoot != "/Users/operator/Library/Application Support/OpenHermesBot/edge-setup" || !legacy.Namespace.IsLegacy() || current.Namespace.IsLegacy() {
		t.Fatalf("legacy root = %s", legacy.AppRoot)
	}
	for _, p := range []MacRuntimePaths{current, legacy} {
		lock := p.Namespace.LockIn(home)
		if rel, err := filepath.Rel(p.AppRoot, lock); err != nil || !strings.HasPrefix(rel, "..") {
			t.Fatalf("lock %s would be removed with %s", lock, p.AppRoot)
		}
		if filepath.Dir(p.ExecutablePath) != filepath.Join(p.AppRoot, "bin") || filepath.Dir(p.RuntimeEnv) != p.RuntimeRoot {
			t.Fatal("namespace paths are not rooted in their AppRoot")
		}
	}
	if current.Namespace.LogsIn(home) != "/Users/operator/Library/Logs/app.openedbot.edge-setup" || current.Namespace.LabelPrefix != "app.openedbot.edge-setup." {
		t.Fatal("current logs or labels do not follow the app identifier")
	}
	if _, err := MacRuntimeIn(MacNamespace{AppRoot: "elsewhere"}, home); err == nil {
		t.Fatal("unknown namespace accepted")
	}
}

func TestConnectorHostKeepsProvisionedLinuxPaths(t *testing.T) {
	p, err := ConnectorPaths("linux", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.ConnectorRoot != ConnectorDir || p.StateRoot != ConnectorStateDir || p.ToolConfig != ToolConfig || p.RuntimeEnv != RuntimeEnv || p.OperatorSocket != OperatorSocket {
		t.Fatal("existing Linux namespace changed")
	}
}

func TestMacConnectorPathsBelongToTheCurrentUser(t *testing.T) {
	home := "/Users/operator"
	p, err := ConnectorPaths("darwin", home)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup")
	if p.ConnectorRoot != filepath.Join(root, "connector") || p.StateRoot != filepath.Join(root, "connector-state") || p.ToolConfig != filepath.Join(root, "config.json") {
		t.Fatal("macOS paths not scoped to the user")
	}
	inst, _ := ParseConnectorInstance("work")
	if inst.DirUnder(p.ConnectorRoot) == DefaultConnectorInstance.DirUnder(p.ConnectorRoot) {
		t.Fatal("instances share credentials")
	}
	for _, invalid := range []string{"", "/", "relative", "/Users/operator/../other", "/Users/operator\n", "/Users/operator\x00"} {
		if _, err := ConnectorPaths("darwin", invalid); err == nil {
			t.Fatalf("accepted invalid home %q", invalid)
		}
	}
	if _, err := ConnectorPaths("windows", home); err == nil {
		t.Fatal("unsupported OS accepted")
	}
}
