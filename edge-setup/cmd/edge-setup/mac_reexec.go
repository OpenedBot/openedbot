package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type macReexecEnv struct {
	home       func() (string, error)
	executable func() (string, error)
	present    func(string) (bool, error)
	sameFile   func(string, string) (bool, error)
	run        func(string, []string) error
	stderr     io.Writer
}

// Enrollment and upgrade use the installed path that the LaunchAgent uses.
// Other commands invoked through an alias of that same inode do so as well.
// Re-execution preserves stdin and cannot bypass an upgraded image's ACL.
func reexecMacCommand(args []string) (int, bool) {
	return reexecMacWith(args, macReexecEnv{home: os.UserHomeDir, executable: os.Executable,
		present: func(path string) (bool, error) { return fsx.RequireRegular(path, 0o700, fsx.Current()) },
		sameFile: func(a, b string) (bool, error) {
			source, err := os.Stat(a)
			if err != nil {
				return false, err
			}
			target, err := os.Stat(b)
			if err != nil {
				return false, err
			}
			return os.SameFile(source, target), nil
		},
		run: func(path string, argv []string) error {
			cmd := exec.Command(path, argv...)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
			return cmd.Run()
		}, stderr: os.Stderr,
	})
}

func reexecMacWith(args []string, e macReexecEnv) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	home, err := e.home()
	if err != nil {
		return 0, false
	}
	p, err := layout.ConnectorPaths("darwin", home)
	if err != nil {
		return 0, false
	}
	present, err := e.present(p.ExecutablePath)
	if err != nil || !present {
		return 0, false
	}
	self, err := e.executable()
	if err != nil {
		return 0, false
	}
	if filepath.Clean(self) == p.ExecutablePath {
		return 0, false
	}
	same, err := e.sameFile(self, p.ExecutablePath)
	if err != nil || !same && args[0] != "link" && args[0] != "upgrade" {
		return 0, false
	}
	if err := e.run(p.ExecutablePath, args); err != nil {
		var status *exec.ExitError
		if errors.As(err, &status) {
			return status.ExitCode(), true
		}
		fmt.Fprintln(e.stderr, "edge-setup: installed macOS command could not start")
		return cli.ExitFailure, true
	}
	return cli.ExitOK, true
}
