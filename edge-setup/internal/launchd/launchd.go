// Package launchd manages one edge-setup connector as a per-user macOS
// LaunchAgent. It does not manage Hermes or any other host service.
package launchd

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const labelPrefix = "com.openhermesbot.edge-setup.connector."

// Kind selects one fixed local service. It never accepts a command or unit
// name from an API request.
type Kind string

const (
	Connector Kind = ""
	Gateway   Kind = "gateway"
	Operator  Kind = "operator"
)

// Config contains paths and identity supplied by the command layer. The
// credential and state directories must already be prepared for the target
// user. Their contents are never read by this package.
type Config struct {
	Runner               exec.Runner
	LaunchctlPath        string
	UID                  int
	HomeDir              string
	ExecutablePath       string
	CredentialsDirectory string
	StateDirectory       string
	Instance             layout.ConnectorInstance
	Kind                 Kind
	RuntimeRoot          string
	VenvBin              string
	NodeBin              string
}

// Status keeps registration separate from process state. launchctl print
// succeeds for a registered job that is waiting and has no running process.
type Status struct {
	Registered bool
	Running    bool
	State      string
	PID        int
}

// Client manages the LaunchAgent whose label and paths are derived from one
// validated connector instance.
type Client struct {
	cfg Config
}

// New validates all identifiers and paths before they can reach launchctl or
// the plist. Only the connector instance name is accepted from user input.
func New(cfg Config) (*Client, error) {
	if cfg.Runner == nil {
		return nil, errors.New("launchd runner is required")
	}
	if cfg.UID < 0 {
		return nil, errors.New("launchd UID must not be negative")
	}
	for _, p := range []struct {
		name  string
		value string
	}{
		{"launchctl path", cfg.LaunchctlPath},
		{"home directory", cfg.HomeDir},
		{"connector executable path", cfg.ExecutablePath},
		{"credentials directory", cfg.CredentialsDirectory},
		{"state directory", cfg.StateDirectory},
	} {
		if err := validateAbsolutePath(p.name, p.value); err != nil {
			return nil, err
		}
	}
	instance, err := layout.ParseConnectorInstance(string(cfg.Instance))
	if err != nil {
		return nil, errors.New("invalid connector instance")
	}
	cfg.Instance = instance
	switch cfg.Kind {
	case Connector:
	case Gateway, Operator:
		if !instance.IsDefault() {
			return nil, errors.New("gateway and operator have one service per user")
		}
		if err := validateAbsolutePath("runtime root", cfg.RuntimeRoot); err != nil {
			return nil, err
		}
		if err := validateAbsolutePath("venv directory", cfg.VenvBin); err != nil {
			return nil, err
		}
		if err := validateAbsolutePath("pinned Node directory", cfg.NodeBin); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("unsupported LaunchAgent kind")
	}
	return &Client{cfg: cfg}, nil
}

func validateAbsolutePath(name, value string) error {
	if value == "" || !filepath.IsAbs(value) || filepath.Clean(value) != value || strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s must be a clean absolute path", name)
	}
	return nil
}

// Label returns the deterministic launchd label for this connector instance.
func (c *Client) Label() string {
	if c.cfg.Kind != Connector {
		return "com.openhermesbot.edge-setup." + string(c.cfg.Kind)
	}
	return labelPrefix + c.cfg.Instance.Label()
}

// Domain returns the current user's GUI launchd domain.
func (c *Client) Domain() string {
	return fmt.Sprintf("gui/%d", c.cfg.UID)
}

// Target returns the exact launchctl service target managed by this client.
func (c *Client) Target() string {
	return c.Domain() + "/" + c.Label()
}

// PlistPath returns this instance's LaunchAgent plist path.
func (c *Client) PlistPath() string {
	return filepath.Join(c.cfg.HomeDir, "Library", "LaunchAgents", c.Label()+".plist")
}

func (c *Client) logPaths() (string, string) {
	base := filepath.Join(c.cfg.HomeDir, "Library", "Logs", "OpenHermesBot")
	return filepath.Join(base, c.Label()+".out.log"), filepath.Join(base, c.Label()+".err.log")
}

// RenderPlist returns an XML LaunchAgent definition. The environment is
// deliberately limited to non-secret paths and the validated instance name.
func (c *Client) RenderPlist() ([]byte, error) {
	stdoutPath, stderrPath := c.logPaths()
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	b.WriteString("<plist version=\"1.0\"><dict>\n")
	writeKey(&b, "Label")
	if err := writeXMLString(&b, c.Label()); err != nil {
		return nil, err
	}

	writeKey(&b, "ProgramArguments")
	b.WriteString("<array>\n")
	args := []string{c.cfg.ExecutablePath, "internal", "connector"}
	switch c.cfg.Kind {
	case Gateway:
		args = []string{c.cfg.ExecutablePath, "-m", "hermes_cli.stderr_timestamp", "--error-log", filepath.Join(c.cfg.RuntimeRoot, "logs", "gateway_errors.log"), "--",
			c.cfg.ExecutablePath, "-m", "hermes_cli.main", "gateway", "run", "--replace", "--external-supervisor"}
	case Operator:
		args = []string{c.cfg.ExecutablePath, "internal", "operator"}
	}
	for _, arg := range args {
		if err := writeXMLString(&b, arg); err != nil {
			return nil, err
		}
	}
	b.WriteString("</array>\n")

	writeKey(&b, "EnvironmentVariables")
	b.WriteString("<dict>\n")
	env := []struct{ key, value string }{
		{"CREDENTIALS_DIRECTORY", c.cfg.CredentialsDirectory},
		{"STATE_DIRECTORY", c.cfg.StateDirectory},
		{"HERMES_CONNECTOR_INSTANCE", string(c.cfg.Instance)},
	}
	if c.cfg.Kind != Connector {
		env = []struct{ key, value string }{
			{"HERMES_HOME", c.cfg.RuntimeRoot},
			{"VIRTUAL_ENV", filepath.Dir(c.cfg.VenvBin)},
			{"PATH", c.cfg.VenvBin + ":" + c.cfg.NodeBin + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
			{"PYTHONUNBUFFERED", "1"},
			{"TERM", "dumb"},
			{"NO_COLOR", "1"},
		}
	}
	for _, item := range env {
		writeKey(&b, item.key)
		if err := writeXMLString(&b, item.value); err != nil {
			return nil, err
		}
	}
	b.WriteString("</dict>\n")

	writeKey(&b, "RunAtLoad")
	b.WriteString("<true/>\n")
	writeKey(&b, "KeepAlive")
	if c.cfg.Kind == Connector {
		// A broker refusal writes this marker. Restarting a revoked link
		// forever would contradict systemd's RestartPreventExitStatus guard.
		b.WriteString("<dict><key>PathState</key><dict>\n<key>")
		if err := xml.EscapeText(&b, []byte(filepath.Join(c.cfg.StateDirectory, "link-refused"))); err != nil {
			return nil, err
		}
		b.WriteString("</key><false/>\n</dict></dict>\n")
	} else {
		b.WriteString("<true/>\n")
	}
	writeKey(&b, "StandardOutPath")
	if err := writeXMLString(&b, stdoutPath); err != nil {
		return nil, err
	}
	writeKey(&b, "StandardErrorPath")
	if err := writeXMLString(&b, stderrPath); err != nil {
		return nil, err
	}
	b.WriteString("</dict></plist>\n")
	return []byte(b.String()), nil
}

func writeKey(b *strings.Builder, key string) {
	b.WriteString("<key>")
	b.WriteString(key)
	b.WriteString("</key>\n")
}

func writeXMLString(b *strings.Builder, value string) error {
	b.WriteString("<string>")
	if err := xml.EscapeText(b, []byte(value)); err != nil {
		return err
	}
	b.WriteString("</string>\n")
	return nil
}

// Install atomically writes a private plist and prepares dedicated logs.
// An existing LaunchAgents directory is shared with other applications.
func (c *Client) Install() error {
	data, err := c.RenderPlist()
	if err != nil {
		return fmt.Errorf("render connector LaunchAgent plist: %w", err)
	}
	plistDir := filepath.Dir(c.PlistPath())
	stdoutPath, _ := c.logPaths()
	logDir := filepath.Dir(stdoutPath)
	if err := ensureLaunchAgentsDirectory(plistDir); err != nil {
		return fmt.Errorf("prepare LaunchAgents directory: %w", err)
	}
	if err := ensurePrivateDirectory(logDir); err != nil {
		return fmt.Errorf("prepare private connector log directory: %w", err)
	}
	return writeAtomicPrivate(c.PlistPath(), plistDir, data)
}

func ensureLaunchAgentsDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
		return errors.New("LaunchAgents directory must be a directory not writable by other users")
	}
	return nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("private directory path is not a directory")
	}
	return os.Chmod(path, 0o700)
}

func writeAtomicPrivate(path, dir string, data []byte) (err error) {
	tmp, err := os.CreateTemp(dir, ".launchd-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return err
	}
	return nil
}

// Start installs the plist, bootstraps it into gui/<uid>, confirms that
// launchd registered the label, then asks launchd to start it. A failed or
// silently ineffective bootstrap is returned as an error.
func (c *Client) Start(ctx context.Context) error {
	if err := c.Install(); err != nil {
		return err
	}
	return c.StartInstalled(ctx)
}

// StartInstalled loads this job's existing private plist without rendering a
// replacement. Upgrade rollback uses it to restore the exact saved definition.
func (c *Client) StartInstalled(ctx context.Context) error {
	present, err := fsx.RequireRegular(c.PlistPath(), 0o600, fsx.Current())
	if err != nil || !present {
		return errors.New("installed LaunchAgent plist is missing or unsafe")
	}
	if err := c.mustRun(ctx, "bootstrap", c.Domain(), c.PlistPath()); err != nil {
		return err
	}
	status, err := c.Status(ctx)
	if err != nil {
		return fmt.Errorf("verify connector LaunchAgent bootstrap: %w", err)
	}
	if !status.Registered {
		return errors.New("launchctl bootstrap succeeded but did not register the connector LaunchAgent")
	}
	return c.mustRun(ctx, "kickstart", c.Target())
}

// Stop unloads only this connector instance. A confirmed missing service is
// already stopped; other launchctl errors remain visible to the caller.
func (c *Client) Stop(ctx context.Context) error {
	res, err := c.run(ctx, "bootout", c.Target())
	if err != nil {
		return err
	}
	if res.ExitCode == 0 || knownNotRegistered(res) {
		return nil
	}
	return commandError("bootout", res.ExitCode)
}

// Restart asks launchd to terminate and relaunch this registered connector.
func (c *Client) Restart(ctx context.Context) error {
	return c.mustRun(ctx, "kickstart", "-k", c.Target())
}

// Status queries only this job. A successful print means Registered; Running
// also requires launchd to report state "running" and a positive process ID.
func (c *Client) Status(ctx context.Context) (Status, error) {
	res, err := c.run(ctx, "print", c.Target())
	if err != nil {
		return Status{}, err
	}
	if res.ExitCode != 0 {
		if knownNotRegistered(res) {
			return Status{}, nil
		}
		return Status{}, commandError("print", res.ExitCode)
	}
	state, pid := parsePrintOutput(res.Stdout)
	return Status{
		Registered: true,
		Running:    state == "running" && pid > 0,
		State:      state,
		PID:        pid,
	}, nil
}

func parsePrintOutput(output string) (string, int) {
	var state string
	var pid int
	depth, jobDepth := 0, 0
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasSuffix(line, "{") {
			depth++
			if jobDepth == 0 {
				jobDepth = depth
			}
			continue
		}
		if strings.HasPrefix(line, "}") {
			depth--
			continue
		}
		// launchctl also prints nested process and resource dictionaries.
		// Their state or PID cannot prove that this connector is running.
		if depth != jobDepth {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "state":
			if state == "" {
				state = strings.ToLower(value)
			}
		case "pid":
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
				pid = parsed
			}
		}
	}
	return state, pid
}

func knownNotRegistered(result exec.Result) bool {
	if result.ExitCode != 3 && result.ExitCode != 113 && result.ExitCode != 125 {
		return false
	}
	diagnostic := strings.ToLower(result.Stdout + "\n" + result.Stderr)
	return strings.Contains(diagnostic, "could not find service") ||
		strings.Contains(diagnostic, "no such process") ||
		strings.Contains(diagnostic, "service not found")
}

func (c *Client) mustRun(ctx context.Context, args ...string) error {
	res, err := c.run(ctx, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return commandError(args[0], res.ExitCode)
	}
	return nil
}

func (c *Client) run(ctx context.Context, args ...string) (exec.Result, error) {
	res, err := c.cfg.Runner.Run(ctx, exec.Cmd{
		Path:    c.cfg.LaunchctlPath,
		Args:    args,
		Timeout: 30 * time.Second,
	})
	if err != nil {
		return res, fmt.Errorf("run launchctl %s: %w", args[0], err)
	}
	return res, nil
}

func commandError(action string, exitCode int) error {
	return fmt.Errorf("launchctl %s failed with exit code %d", action, exitCode)
}
