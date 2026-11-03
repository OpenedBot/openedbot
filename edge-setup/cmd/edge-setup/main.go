// Command edge-setup installs, hardens and links a Hermes agent runtime on
// the host it runs on. It is the single operator entrypoint of this
// repository: every privileged action lives behind one of its subcommands.
package main

import (
	"errors"
	"fmt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	_ "github.com/OpenedBot/openedbot/edge-setup/internal/commands"
)

// version is stamped at build time with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	tightenUmask()
	os.Exit(cli.Run(os.Args[1:], cli.Env{
		Version: version,
		Stdout:  os.Stdout,
		Stderr:  os.Stderr,
		Elevate: elevate,
		Journal: journalPath(),
	}))
}

// tightenUmask adds the group and world write bits to the inherited umask.
// The trees this tool and the installers it runs create as root (runtime,
// interpreter, data, units) take their modes from it: a shell or a container
// exec with umask 0 would leave them writable by any local user. A stricter
// umask (the connector unit's 0077) is kept as it is.
func tightenUmask() {
	syscall.Umask(syscall.Umask(0o022) | 0o022)
}

// journalPath is the install journal on Linux; macOS keeps none.
func journalPath() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	return layout.ToolJournal
}

// elevate re-executes this binary through sudo when the caller is not root.
// sudo's own policy still decides (password prompt on a TTY, NOPASSWD, or a
// refusal); EDGE_SETUP_NO_SUDO=1 disables the re-exec (the pre-rename
// HERMES_SETUP_NO_SUDO is still honoured when the new name is unset), and a
// host without sudo falls through to the command's own "must run as root"
// message. Secrets keep travelling on stdin or in files: sudo inherits stdin.
func elevate(args []string) (int, bool) {
	// macOS connector commands belong to the login user's LaunchAgent and
	// Keychain. Root would select another domain and another identity store.
	if runtime.GOOS == "darwin" {
		return reexecMacCommand(args)
	}
	return elevateWith(elevateEnv{
		euid:       os.Geteuid(),
		getenv:     os.Getenv,
		lookPath:   exec.LookPath,
		executable: os.Executable,
		run: func(c *exec.Cmd) error {
			c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
			return c.Run()
		},
		stderr: os.Stderr,
	}, args)
}

// elevateEnv is what elevate needs from the process, injected so the
// re-execution contract can be proven without a real sudo.
type elevateEnv struct {
	euid       int
	getenv     func(string) string
	lookPath   func(string) (string, error)
	executable func() (string, error)
	run        func(*exec.Cmd) error
	stderr     io.Writer
}

// elevateWith holds the contract: root and the recursion guard never
// re-execute, a host without sudo falls through to the command's own
// refusal, the child inherits the exact argv plus the guard, and the
// child's exit code is the process's exit code.
func elevateWith(e elevateEnv, args []string) (int, bool) {
	if e.euid == 0 || e.getenv("EDGE_SETUP_NO_SUDO") == "1" || e.getenv("HERMES_SETUP_NO_SUDO") == "1" {
		return 0, false
	}
	sudo, err := e.lookPath("sudo")
	if err != nil {
		return 0, false
	}
	self, err := e.executable()
	if err != nil {
		return 0, false
	}
	cmd := exec.Command(sudo, append([]string{"--", self}, args...)...)
	cmd.Env = append(os.Environ(), "EDGE_SETUP_NO_SUDO=1")
	if err := e.run(cmd); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), true
		}
		fmt.Fprintf(e.stderr, "edge-setup: sudo: %v\n", err)
		return cli.ExitFailure, true
	}
	return cli.ExitOK, true
}
