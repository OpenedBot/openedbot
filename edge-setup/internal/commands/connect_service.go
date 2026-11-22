package commands

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// connectServiceName names the user service of one pairing (origin,
// workspace and folder): the state directory's own name.
func connectServiceName(setup connectSetup) string {
	return "openedbot-connect-" + filepath.Base(setup.root)
}

// connectServiceArgs is the command the service runs. PATH is the caller's,
// saved at install: a user service starts with a short one, without nvm,
// Bun or the CLIs' own folders.
func connectServiceArgs(setup connectSetup) ([]string, error) {
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err != nil {
		return nil, errors.New("cannot locate the edge-setup executable")
	}
	return []string{executable, "connect", "--serve", "--openedbot", setup.origin, "--workspace-id", setup.workspaceID, "--workspace", setup.workspace, "--state-root", setup.root}, nil
}

// installUserService writes, enables and (re)starts the service that runs the
// paired agents in the background, across logouts and reboots.
func installUserService(env cli.Env, setup connectSetup) error {
	args, err := connectServiceArgs(setup)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "linux":
		return installSystemdUserService(env, setup, args)
	case "darwin":
		return installLaunchAgent(env, setup, args)
	}
	return fmt.Errorf("no user service on %s: run edge-setup connect --foreground", runtime.GOOS)
}

// systemdQuote quotes one word of a unit file: `%` is a specifier there, and
// systemd expands `$VAR` and `${VAR}` even inside quotes.
func systemdQuote(value string) string {
	value = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(value)
	return `"` + value + `"`
}

func renderSystemdUnit(setup connectSetup, args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = systemdQuote(arg)
	}
	return strings.Join([]string{
		"[Unit]",
		"Description=openedbot agents of " + strings.ReplaceAll(setup.workspace, "%", "%%"),
		"Wants=network-online.target",
		"After=network-online.target",
		"",
		"[Service]",
		"ExecStart=" + strings.Join(quoted, " "),
		"Environment=" + systemdQuote("PATH="+setup.path),
		"Restart=on-failure",
		"RestartSec=10",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	}, "\n")
}

// stopUserService stops this pairing's service, if one runs: best effort.
func stopUserService(setup connectSetup) {
	switch runtime.GOOS {
	case "linux":
		_ = exec.Command("systemctl", "--user", "stop", connectServiceName(setup)+".service").Run()
	case "darwin":
		_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d/app.openedbot.%s", os.Getuid(), connectServiceName(setup))).Run()
	}
}

func installSystemdUserService(env cli.Env, setup connectSetup, args []string) error {
	name := connectServiceName(setup) + ".service"
	dir := filepath.Join(setup.home, ".config", "systemd", "user")
	if err := fsx.EnsureDir(dir, 0700, fsx.Current()); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(filepath.Join(dir, name), []byte(renderSystemdUnit(setup, args)), 0600, fsx.Current()); err != nil {
		return err
	}
	for _, step := range [][]string{{"daemon-reload"}, {"enable", name}, {"restart", name}} {
		if output, err := exec.Command("systemctl", append([]string{"--user"}, step...)...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl --user %s: %s", strings.Join(step, " "), strings.TrimSpace(string(output)))
		}
	}
	printf(env.Stdout, "Service %s started: systemctl --user status %s", name, name)
	// Without linger, the user's services stop at logout.
	if output, err := exec.Command("loginctl", "enable-linger").CombinedOutput(); err != nil {
		printf(env.Stdout, "Warning: the agents stop when you log out (loginctl enable-linger: %s). Ask an administrator for: sudo loginctl enable-linger %s",
			strings.TrimSpace(string(output)), os.Getenv("USER"))
	}
	return nil
}

func renderLaunchAgent(label string, setup connectSetup, args []string) (string, error) {
	escape := func(value string) (string, error) {
		var b strings.Builder
		if err := xml.EscapeText(&b, []byte(value)); err != nil {
			return "", err
		}
		return b.String(), nil
	}
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n")
	value, err := escape(label)
	if err != nil {
		return "", err
	}
	b.WriteString("<key>Label</key><string>" + value + "</string>\n<key>ProgramArguments</key><array>\n")
	for _, arg := range args {
		if value, err = escape(arg); err != nil {
			return "", err
		}
		b.WriteString("<string>" + value + "</string>\n")
	}
	if value, err = escape(setup.path); err != nil {
		return "", err
	}
	b.WriteString("</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>" + value + "</string></dict>\n")
	b.WriteString("<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n")
	return b.String(), nil
}

func installLaunchAgent(env cli.Env, setup connectSetup, args []string) error {
	label := "app.openedbot." + connectServiceName(setup)
	plist, err := renderLaunchAgent(label, setup, args)
	if err != nil {
		return err
	}
	dir := filepath.Join(setup.home, "Library", "LaunchAgents")
	if err := fsx.EnsureDir(dir, 0700, fsx.Current()); err != nil {
		return err
	}
	path := filepath.Join(dir, label+".plist")
	if err := fsx.WriteAtomic(path, []byte(plist), 0600, fsx.Current()); err != nil {
		return err
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	_ = exec.Command("launchctl", "bootout", domain+"/"+label).Run()
	if output, err := exec.Command("launchctl", "bootstrap", domain, path).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %s", strings.TrimSpace(string(output)))
	}
	printf(env.Stdout, "LaunchAgent %s started.", label)
	return nil
}
