package launchd

import (
	"bytes"
	"encoding/xml"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func newHostServiceClient(t *testing.T, home string, kind Kind, instance layout.ConnectorInstance) *Client {
	t.Helper()
	root := filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "runtime")
	venvBin := filepath.Join(root, "releases", "fixture", "hermes-agent", "venv", "bin")
	executable := filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "bin", "edge-setup")
	if kind == Gateway {
		executable = filepath.Join(venvBin, "python")
	}
	client, err := New(Config{
		Runner:               exectest.NewFake(),
		LaunchctlPath:        "/bin/launchctl",
		UID:                  501,
		HomeDir:              home,
		ExecutablePath:       executable,
		CredentialsDirectory: filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "connector"),
		StateDirectory:       filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "connector-state"),
		Instance:             instance,
		Kind:                 kind,
		RuntimeRoot:          root,
		VenvBin:              venvBin,
		NodeBin:              filepath.Join(root, "node", "v22", "bin"),
	})
	if err != nil {
		t.Fatal("could not construct temporary openedbot host service")
	}
	return client
}

func keepAliveFragment(t *testing.T, plist []byte) string {
	t.Helper()
	parts := strings.SplitN(string(plist), "<key>KeepAlive</key>\n", 2)
	if len(parts) != 2 {
		t.Fatal("LaunchAgent plist has no KeepAlive setting")
	}
	parts = strings.SplitN(parts[1], "<key>StandardOutPath</key>", 2)
	if len(parts) != 2 {
		t.Fatal("LaunchAgent plist has no output path after KeepAlive")
	}
	return parts[0]
}

func programArguments(t *testing.T, plist []byte) []string {
	t.Helper()
	decoder := xml.NewDecoder(bytes.NewReader(plist))
	for {
		token, err := decoder.Token()
		if err != nil {
			t.Fatal("LaunchAgent plist has no ProgramArguments array")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "key" {
			continue
		}
		var key string
		if err := decoder.DecodeElement(&key, &start); err != nil {
			t.Fatal("LaunchAgent plist contains an invalid key")
		}
		if key != "ProgramArguments" {
			continue
		}
		args := []string{}
		for {
			token, err := decoder.Token()
			if err != nil {
				t.Fatal("LaunchAgent ProgramArguments array is incomplete")
			}
			switch item := token.(type) {
			case xml.StartElement:
				if item.Name.Local == "string" {
					var arg string
					if err := decoder.DecodeElement(&arg, &item); err != nil {
						t.Fatal("LaunchAgent argument is not valid XML text")
					}
					args = append(args, arg)
				}
			case xml.EndElement:
				if item.Name.Local == "array" {
					return args
				}
			}
		}
	}
}

func TestGatewayAndOperatorUseDistinctOpenedbotLabelsAndPinnedRuntimeArguments(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "runtime")
	python := filepath.Join(root, "releases", "fixture", "hermes-agent", "venv", "bin", "python")
	venvBin := filepath.Dir(python)
	nodeBin := filepath.Join(root, "node", "v22", "bin")
	for _, tc := range []struct {
		kind       Kind
		label      string
		args       []string
		keepAlive  string
		executable string
	}{
		{Gateway, "app.openedbot.edge-setup.gateway", []string{python, "-m", "hermes_cli.stderr_timestamp", "--error-log", filepath.Join(root, "logs", "gateway_errors.log"), "--", python, "-m", "hermes_cli.main", "gateway", "run", "--replace", "--external-supervisor"}, "<true/>\n", python},
		{Operator, "app.openedbot.edge-setup.operator", []string{filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "bin", "edge-setup"), "internal", "operator"}, "<true/>\n", filepath.Join(home, "Library", "Application Support", "app.openedbot.edge-setup", "bin", "edge-setup")},
	} {
		t.Run(string(tc.kind), func(t *testing.T) {
			client := newHostServiceClient(t, home, tc.kind, layout.DefaultConnectorInstance)
			if client.Label() != tc.label || client.Label() == "ai.hermes.gateway" {
				t.Fatal("openedbot host service label is not distinct from the personal Hermes gateway")
			}
			plist, err := client.RenderPlist()
			if err != nil {
				t.Fatal("could not render temporary host service plist")
			}
			text := string(plist)
			if strings.Contains(text, "API_SERVER_KEY") || strings.Contains(text, "fixture-bearer") {
				t.Fatal("host service plist contains a credential")
			}
			if !strings.Contains(text, "<key>Label</key>\n<string>"+tc.label+"</string>") {
				t.Fatal("host service plist label does not match its fixed kind")
			}
			if got := programArguments(t, plist); !reflect.DeepEqual(got, tc.args) {
				t.Fatalf("host service ProgramArguments do not match the fixed %s invocation", tc.kind)
			}
			if !strings.Contains(text, "<key>HERMES_HOME</key>\n<string>"+root+"</string>") || !strings.Contains(text, "<key>PATH</key>\n<string>"+venvBin+":"+nodeBin+":") {
				t.Fatal("host service plist does not use its private Hermes and pinned Node paths")
			}
			if got := keepAliveFragment(t, plist); got != tc.keepAlive {
				t.Fatalf("host service KeepAlive source differs from its fixed contract for %s", tc.kind)
			}
		})
	}
}

func TestConnectorKeepAliveUsesOnlyTheRefusalMarkerSourceCriterion(t *testing.T) {
	home := t.TempDir()
	client := newHostServiceClient(t, home, Connector, "lab-runtime-01")
	plist, err := client.RenderPlist()
	if err != nil {
		t.Fatal("could not render temporary connector plist")
	}
	marker := filepath.Join(client.cfg.StateDirectory, "link-refused")
	want := "<dict><key>PathState</key><dict>\n<key>" + marker + "</key><false/>\n</dict></dict>\n"
	if got := keepAliveFragment(t, plist); got != want {
		t.Fatal("connector plist does not restrict KeepAlive to the refusal marker being absent")
	}
}

func TestHostServiceKindsAreOnePerUserAndRejectUnknownKinds(t *testing.T) {
	home := t.TempDir()
	base := Config{
		Runner:               exectest.NewFake(),
		LaunchctlPath:        "/bin/launchctl",
		UID:                  501,
		HomeDir:              home,
		ExecutablePath:       filepath.Join(home, "bin", "edge-setup"),
		CredentialsDirectory: filepath.Join(home, "credentials"),
		StateDirectory:       filepath.Join(home, "state"),
		RuntimeRoot:          filepath.Join(home, "runtime"),
		VenvBin:              filepath.Join(home, "runtime", "venv", "bin"),
		NodeBin:              filepath.Join(home, "runtime", "node", "bin"),
	}
	for _, kind := range []Kind{Gateway, Operator} {
		cfg := base
		cfg.Kind = kind
		cfg.Instance = "lab-runtime-01"
		if _, err := New(cfg); err == nil {
			t.Fatalf("named %s service was accepted", kind)
		}
	}
	base.Kind = Kind("customer-unit")
	if _, err := New(base); err == nil {
		t.Fatal("unknown service kind was accepted")
	}
}

func TestInstallingOpenedbotGatewayPreservesPersonalHermesGatewayPlist(t *testing.T) {
	home := t.TempDir()
	launchAgents := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(launchAgents, 0o755); err != nil {
		t.Fatal("could not create temporary LaunchAgents directory")
	}
	personalPath := filepath.Join(launchAgents, "ai.hermes.gateway.plist")
	personalPlist := []byte("personal Hermes gateway fixture")
	if err := os.WriteFile(personalPath, personalPlist, 0o600); err != nil {
		t.Fatal("could not create personal Hermes fixture plist")
	}
	client := newHostServiceClient(t, home, Gateway, layout.DefaultConnectorInstance)
	if err := client.Install(); err != nil {
		t.Fatal("could not install the temporary openedbot gateway plist")
	}
	got, err := os.ReadFile(personalPath)
	if err != nil || string(got) != string(personalPlist) {
		t.Fatal("installing openedbot replaced the personal Hermes gateway plist")
	}
	if client.PlistPath() == personalPath || client.Label() == "ai.hermes.gateway" {
		t.Fatal("openedbot gateway targets the personal Hermes LaunchAgent")
	}
	if _, err := os.Stat(client.PlistPath()); err != nil {
		t.Fatal("openedbot did not write its own separate gateway plist")
	}
}
