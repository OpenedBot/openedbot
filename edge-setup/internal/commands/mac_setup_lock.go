package commands

import (
	"errors"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// The lock survives installation removal so setup and reset keep locking
// the same inode through their final readback. It contains no credentials.
func macSetupLockPath(p layout.MacRuntimePaths) string {
	return p.Namespace.LockIn(p.Home)
}

func lockMacRuntime(p layout.MacRuntimePaths) (func(), error) {
	want, err := layout.MacRuntimeIn(p.Namespace, p.Home)
	if err != nil || want != p {
		return nil, errors.New("macOS setup lock path is invalid")
	}
	parent := filepath.Dir(macSetupLockPath(p))
	info, err := fsx.Lstat(parent)
	if err != nil || (info.Exists && (!info.Dir || info.Symlink || info.Owner != fsx.Current() || info.Mode&0o022 != 0)) {
		return nil, errors.New("macOS setup lock directory is unsafe or belongs to another user")
	}
	if !info.Exists {
		if err := fsx.EnsureDir(parent, 0o700, fsx.Current()); err != nil {
			return nil, errors.New("macOS setup lock directory could not be prepared")
		}
	}
	return lockMacSetup(macSetupLockPath(p))
}
