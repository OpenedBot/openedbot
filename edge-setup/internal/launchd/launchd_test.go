package launchd

import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func newTestClient(t *testing.T, home string, instance layout.ConnectorInstance, runner exec.Runner) *Client {
	t.Helper()
	c, err := New(Config{
		Runner:               runner,
		LaunchctlPath:        "/bin/launchctl",
		UID:                  501,
		HomeDir:              home,
		ExecutablePath:       "/opt/openedbot/edge-setup",
		CredentialsDirectory: filepath.Join(home, "Library", "Application Support", "openedbot", "credentials"),
		StateDirectory:       filepath.Join(home, "Library", "Application Support", "openedbot", "state"),
		Instance:             instance,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestInstallPreservesOtherApplicationsLaunchAgents(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "com.other.application.plist")
	if err := os.WriteFile(other, []byte("other application"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := newTestClient(t, home, "blue", exectest.NewFake())
	if err := c.Install(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("shared LaunchAgents directory permissions changed: %v", err)
	}
	data, err := os.ReadFile(other)
	if err != nil || string(data) != "other application" {
		t.Fatalf("another application's LaunchAgent changed: %v", err)
	}
	info, err = os.Stat(c.PlistPath())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("connector plist is not private: %v", err)
	}
}

func assertCommand(t *testing.T, got exec.Cmd, path string, args ...string) {
	t.Helper()
	if got.Path != path {
		t.Fatalf("command path = %q, want %q", got.Path, path)
	}
	if len(got.Args) != len(args) {
		t.Fatalf("command args = %q, want %q", got.Args, args)
	}
	for i := range args {
		if got.Args[i] != args[i] {
			t.Fatalf("command args = %q, want %q", got.Args, args)
		}
	}
}

func TestNewRejectsUnvalidatedInstanceAndRelativePaths(t *testing.T) {
	base := Config{
		Runner:               exectest.NewFake(),
		LaunchctlPath:        "/bin/launchctl",
		UID:                  501,
		HomeDir:              "/Users/operator",
		ExecutablePath:       "/opt/openedbot/edge-setup",
		CredentialsDirectory: "/Users/operator/Library/Application Support/openedbot/credentials",
		StateDirectory:       "/Users/operator/Library/Application Support/openedbot/state",
	}
	for _, tc := range []struct {
		name string
		edit func(*Config)
	}{
		{"instance traversal", func(c *Config) { c.Instance = "../bad" }},
		{"relative executable", func(c *Config) { c.ExecutablePath = "edge-setup" }},
		{"newline in credentials path", func(c *Config) { c.CredentialsDirectory = "/Users/operator/creds\nvalue" }},
		{"negative UID", func(c *Config) { c.UID = -1 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base
			tc.edit(&cfg)
			if _, err := New(cfg); err == nil {
				t.Fatal("invalid configuration was accepted")
			}
		})
	}
}

func xmlTextValues(data []byte) ([]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var values []string
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return values, nil
		}
		if err != nil {
			return nil, err
		}
		if text, ok := token.(xml.CharData); ok {
			value := strings.TrimSpace(string(text))
			if value != "" {
				values = append(values, value)
			}
		}
	}
}

func TestRenderPlistEscapesXMLAndUsesBoundedLaunchAgentContract(t *testing.T) {
	home := filepath.Join(t.TempDir(), "owner&<west>")
	cfg := Config{
		Runner:               exectest.NewFake(),
		LaunchctlPath:        "/bin/launchctl",
		UID:                  501,
		HomeDir:              home,
		ExecutablePath:       "/opt/openedbot/edge<&>-setup",
		CredentialsDirectory: filepath.Join(home, "credentials&<path>"),
		StateDirectory:       filepath.Join(home, "state&<path>"),
		Instance:             "blue-1",
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	data, err := c.RenderPlist()
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "owner&<west>") || strings.Contains(text, "edge<&>") {
		t.Fatal("plist contains unescaped XML text")
	}
	if !strings.Contains(text, "owner&amp;&lt;west&gt;") || !strings.Contains(text, "edge&lt;&amp;&gt;-setup") {
		t.Fatalf("plist did not escape XML values: %s", text)
	}
	if !strings.Contains(text, "<key>RunAtLoad</key>\n<true/>") || !strings.Contains(text, "<key>KeepAlive</key>\n<dict><key>PathState</key>") || !strings.Contains(text, "link-refused</key><false/>") {
		t.Fatal("plist must start at load and keep the connector alive")
	}
	if !strings.Contains(text, "<key>StandardOutPath</key>") || !strings.Contains(text, "<key>StandardErrorPath</key>") {
		t.Fatal("plist must route stdout and stderr to explicit log files")
	}
	if strings.Contains(text, "secret-token") || strings.Contains(text, "HERMES_API_KEY") {
		t.Fatal("plist contains an unexpected secret environment variable")
	}
	values, err := xmlTextValues(data)
	if err != nil {
		t.Fatalf("read parsed plist values: %v", err)
	}
	valueSet := make(map[string]bool, len(values))
	for _, value := range values {
		valueSet[value] = true
	}
	for _, want := range []string{
		cfg.ExecutablePath, "internal", "connector",
		cfg.CredentialsDirectory, cfg.StateDirectory, "blue-1",
		filepath.Join(home, "Library", "Logs", "app.openedbot.edge-setup", c.Label()+".out.log"),
		filepath.Join(home, "Library", "Logs", "app.openedbot.edge-setup", c.Label()+".err.log"),
	} {
		if !valueSet[want] {
			t.Errorf("parsed plist is missing string %q", want)
		}
	}
}

func TestInstancesHaveSeparateLabelsAndPlistPaths(t *testing.T) {
	home := t.TempDir()
	defaultClient := newTestClient(t, home, layout.DefaultConnectorInstance, exectest.NewFake())
	namedClient := newTestClient(t, home, "blue", exectest.NewFake())
	if defaultClient.Label() == namedClient.Label() {
		t.Fatal("different instances share a launchd label")
	}
	if defaultClient.PlistPath() == namedClient.PlistPath() {
		t.Fatal("different instances share a plist path")
	}
	if defaultClient.Target() == namedClient.Target() {
		t.Fatal("different instances share a launchctl target")
	}
	defaultPlist, err := defaultClient.RenderPlist()
	if err != nil {
		t.Fatal(err)
	}
	namedPlist, err := namedClient.RenderPlist()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(defaultPlist), "<string>blue</string>") || !strings.Contains(string(namedPlist), "<string>blue</string>") {
		t.Fatal("connector instance leaked across plist definitions")
	}
}

func TestInstallWritesPrivatePlistAndParents(t *testing.T) {
	home := t.TempDir()
	c := newTestClient(t, home, "blue", exectest.NewFake())
	if err := c.Install(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(c.PlistPath())
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("plist mode = %04o, want 0600", got)
	}
	for _, path := range []string{filepath.Dir(c.PlistPath()), filepath.Join(home, "Library", "Logs", "app.openedbot.edge-setup")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o700 {
			t.Errorf("private directory %s mode = %04o, want 0700", path, got)
		}
	}
}

func TestStartUsesGuiDomainAndDoesNotHideBootstrapFailure(t *testing.T) {
	home := t.TempDir()
	failed := exectest.NewFake()
	c := newTestClient(t, home, "blue", failed)
	bootstrap := "/bin/launchctl bootstrap gui/501 " + c.PlistPath()
	failed.On(bootstrap, exec.Result{ExitCode: 5, Stderr: "bootstrap failed"})
	if err := c.Start(context.Background()); err == nil {
		t.Fatal("failed bootstrap was reported as success")
	}
	if len(failed.Calls) != 1 {
		t.Fatalf("commands after failed bootstrap = %v", failed.Commands())
	}
	assertCommand(t, failed.Calls[0], "/bin/launchctl", "bootstrap", "gui/501", c.PlistPath())

	runner := exectest.NewFake().OnPrefix("/bin/launchctl", exec.Result{})
	c = newTestClient(t, t.TempDir(), "blue", runner)
	if err := c.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.Calls) != 3 {
		t.Fatalf("launchctl calls = %v, want bootstrap, print, kickstart", runner.Commands())
	}
	assertCommand(t, runner.Calls[0], "/bin/launchctl", "bootstrap", "gui/501", c.PlistPath())
	assertCommand(t, runner.Calls[1], "/bin/launchctl", "print", c.Target())
	assertCommand(t, runner.Calls[2], "/bin/launchctl", "kickstart", c.Target())
}

func TestStartRejectsBootstrapThatDidNotRegisterJob(t *testing.T) {
	runner := exectest.NewFake()
	c := newTestClient(t, t.TempDir(), "blue", runner)
	runner.On("/bin/launchctl bootstrap gui/501 "+c.PlistPath(), exec.Result{})
	runner.On("/bin/launchctl print "+c.Target(), exec.Result{ExitCode: 113, Stderr: "Could not find service"})
	if err := c.Start(context.Background()); err == nil {
		t.Fatal("bootstrap that did not register the service was reported as success")
	}
	if calls := runner.Commands(); len(calls) != 2 {
		t.Fatalf("unexpected calls after unregistered bootstrap: %v", calls)
	}
	assertCommand(t, runner.Calls[1], "/bin/launchctl", "print", c.Target())
}

func TestStopOnlyIgnoresAConfirmedMissingService(t *testing.T) {
	for _, tc := range []struct {
		name      string
		res       exec.Result
		wantError bool
	}{
		{name: "already unloaded", res: exec.Result{ExitCode: 3, Stderr: "Boot-out failed: 3: No such process"}},
		{name: "permission failure", res: exec.Result{ExitCode: 3, Stderr: "Operation not permitted"}, wantError: true},
		{name: "unsupported domain", res: exec.Result{ExitCode: 125, Stderr: "Domain does not support specified action"}, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := exectest.NewFake()
			c := newTestClient(t, t.TempDir(), "blue", runner)
			runner.On("/bin/launchctl bootout "+c.Target(), tc.res)
			err := c.Stop(context.Background())
			if len(runner.Calls) != 1 {
				t.Fatalf("launchctl calls = %v, want one bootout", runner.Commands())
			}
			assertCommand(t, runner.Calls[0], "/bin/launchctl", "bootout", c.Target())
			if (err != nil) != tc.wantError {
				t.Fatalf("Stop() error = %v, want error %v", err, tc.wantError)
			}
		})
	}
}

func TestStatusSeparatesRegisteredFromRunning(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
		want Status
	}{
		{name: "registered and waiting", out: "state = waiting\n", want: Status{Registered: true, State: "waiting"}},
		{name: "running", out: "state = running\npid = 904\n", want: Status{Registered: true, Running: true, State: "running", PID: 904}},
		{name: "running without PID is unproven", out: "state = running\n", want: Status{Registered: true, State: "running"}},
		{name: "registered but stopped", out: "state = not running\n", want: Status{Registered: true, State: "not running"}},
		{name: "nested process cannot prove a waiting connector runs", out: "gui/501/connector = {\n state = waiting\n resources = {\n state = running\n pid = 45\n }\n }\n", want: Status{Registered: true, State: "waiting"}},
		{name: "nested PID cannot overwrite the connector PID", out: "gui/501/connector = {\n state = running\n pid = 904\n resources = {\n pid = 45\n }\n }\n", want: Status{Registered: true, Running: true, State: "running", PID: 904}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := exectest.NewFake()
			c := newTestClient(t, t.TempDir(), "blue", runner)
			runner.On("/bin/launchctl print "+c.Target(), exec.Result{Stdout: tc.out})
			got, err := c.Status(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("Status() = %+v, want %+v", got, tc.want)
			}
			assertCommand(t, runner.Calls[0], "/bin/launchctl", "print", c.Target())
		})
	}
}

func TestRestartUsesKickstartForOnlyThisInstance(t *testing.T) {
	runner := exectest.NewFake()
	c := newTestClient(t, t.TempDir(), "blue", runner)
	want := "/bin/launchctl kickstart -k " + c.Target()
	runner.On(want, exec.Result{})
	if err := c.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.Calls) != 1 {
		t.Fatalf("restart calls = %v, want one kickstart", runner.Commands())
	}
	assertCommand(t, runner.Calls[0], "/bin/launchctl", "kickstart", "-k", c.Target())
}
