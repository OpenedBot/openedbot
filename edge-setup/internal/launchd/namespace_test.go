package launchd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestPlistsRenderTheRenamedRootLabelsAndLogs(t *testing.T) {
	home := t.TempDir()
	p, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []Kind{Gateway, Operator, Connector} {
		executable := p.ExecutablePath
		if kind == Gateway {
			executable = filepath.Join(p.VenvBin, "python")
		}
		c, err := New(Config{Runner: exectest.NewFake(), LaunchctlPath: "/bin/launchctl", UID: 501, HomeDir: home,
			ExecutablePath: executable, CredentialsDirectory: p.ConnectorRoot, StateDirectory: p.StateRoot, Kind: kind,
			RuntimeRoot: p.RuntimeRoot, VenvBin: p.VenvBin, NodeBin: p.NodeBin})
		if err != nil {
			t.Fatal(err)
		}
		plist, err := c.RenderPlist()
		if err != nil {
			t.Fatal(err)
		}
		text := string(plist)
		if !strings.HasPrefix(c.Label(), "app.openedbot.edge-setup.") || c.PlistPath() != filepath.Join(home, "Library", "LaunchAgents", c.Label()+".plist") {
			t.Fatalf("%q label %s", kind, c.Label())
		}
		if !strings.Contains(text, p.AppRoot+"/") || !strings.Contains(text, filepath.Join(home, "Library", "Logs", "app.openedbot.edge-setup", c.Label()+".err.log")) {
			t.Fatalf("%q plist does not point into the renamed root and logs:\n%s", kind, text)
		}
		if strings.Contains(strings.ToLower(text), "openhermesbot") {
			t.Fatalf("%q plist still names the previous product:\n%s", kind, text)
		}
	}
}

func TestLegacyNamespaceAddressesOnlyThePreRenameJobs(t *testing.T) {
	home := t.TempDir()
	p, err := layout.MacRuntimeIn(layout.MacLegacy, home)
	if err != nil {
		t.Fatal(err)
	}
	c, err := New(Config{Runner: exectest.NewFake(), LaunchctlPath: "/bin/launchctl", UID: 501, HomeDir: home,
		ExecutablePath: p.ExecutablePath, CredentialsDirectory: p.ConnectorRoot, StateDirectory: p.StateRoot, Kind: Operator,
		RuntimeRoot: p.RuntimeRoot, VenvBin: p.VenvBin, NodeBin: p.NodeBin, Namespace: layout.MacLegacy})
	if err != nil {
		t.Fatal(err)
	}
	if c.Label() != "com.openhermesbot.edge-setup.operator" || c.Target() != "gui/501/com.openhermesbot.edge-setup.operator" {
		t.Fatalf("legacy label = %s", c.Label())
	}
	stdout, _ := c.logPaths()
	if filepath.Dir(stdout) != filepath.Join(home, "Library", "Logs", "OpenHermesBot") {
		t.Fatalf("legacy log = %s", stdout)
	}
	if _, err := New(Config{Runner: exectest.NewFake(), LaunchctlPath: "/bin/launchctl", UID: 501, HomeDir: home,
		ExecutablePath: p.ExecutablePath, CredentialsDirectory: p.ConnectorRoot, StateDirectory: p.StateRoot,
		Namespace: layout.MacNamespace{LabelPrefix: "com.example."}}); err == nil {
		t.Fatal("an unknown label namespace was accepted")
	}
	if _, err := os.Stat(filepath.Join(home, "Library")); !os.IsNotExist(err) {
		t.Fatal("addressing a legacy job wrote files")
	}
}
