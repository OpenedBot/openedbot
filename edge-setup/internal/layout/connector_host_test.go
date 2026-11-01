package layout

import (
	"path/filepath"
	"testing"
)

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
	root := filepath.Join(home, "Library", "Application Support", "OpenHermesBot", "edge-setup")
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
