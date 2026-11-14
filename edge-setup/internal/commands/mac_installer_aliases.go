package commands

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func macInstallerAliasPaths(home string, p layout.MacRuntimePaths) []string {
	return []string{filepath.Join(filepath.Dir(p.ExecutablePath), "hermes-setup"),
		filepath.Join(home, ".local", "bin", "edge-setup"), filepath.Join(home, ".local", "bin", "hermes-setup")}
}

func inspectMacInstallerAliases(home string, p layout.MacRuntimePaths) error {
	want, err := layout.MacRuntimeIn(p.Namespace, home)
	if err != nil || p != want {
		return errors.New("macOS installer alias paths are invalid")
	}
	for _, parent := range []string{filepath.Join(home, ".local"), filepath.Join(home, ".local", "bin"), filepath.Dir(p.ExecutablePath)} {
		info, err := fsx.Lstat(parent)
		if err != nil || info.Exists && (!info.Dir || info.Symlink || info.Owner != fsx.Current() || info.Mode&0o022 != 0) {
			return errors.New("macOS installer alias directory is unsafe or belongs to another user")
		}
	}
	for _, path := range macInstallerAliasPaths(home, p) {
		if _, err := macInstallerAliasOwned(path, p.ExecutablePath); err != nil {
			return err
		}
	}
	return nil
}

func macInstallerAliasOwned(path, target string) (bool, error) {
	info, err := fsx.Lstat(path)
	if err != nil {
		return false, errors.New("macOS installer alias could not be inspected")
	}
	if !info.Exists || !info.Symlink {
		return false, nil
	}
	link, err := os.Readlink(path)
	if err != nil {
		return false, errors.New("macOS installer alias target is unknown")
	}
	if link != target {
		return false, nil
	}
	if info.Owner != fsx.Current() {
		return false, errors.New("macOS managed installer alias belongs to another user")
	}
	return true, nil
}

func removeMacInstallerAliases(home string, p layout.MacRuntimePaths) error {
	if err := inspectMacInstallerAliases(home, p); err != nil {
		return err
	}
	for _, path := range macInstallerAliasPaths(home, p) {
		owned, err := macInstallerAliasOwned(path, p.ExecutablePath)
		if err != nil {
			return err
		}
		if !owned {
			continue
		}
		if err := os.Remove(path); err != nil {
			return errors.New("macOS managed installer alias could not be removed")
		}
		if info, err := fsx.Lstat(path); err != nil || info.Exists {
			return errors.New("macOS managed installer alias removal could not be verified")
		}
	}
	return nil
}
