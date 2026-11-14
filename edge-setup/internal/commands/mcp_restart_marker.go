package commands

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// Preserve the first pending write's timestamp so restarting the operator
// or writing another MCP server cannot hide a change the gateway missed.
func markCLIGatewayRestart(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\x00\r\n") {
		return errors.New("gateway restart marker path is invalid")
	}
	info, err := fsx.Lstat(path)
	if err != nil {
		return errors.New("gateway restart marker could not be inspected")
	}
	if info.Exists {
		if !info.Regular || info.Symlink || info.Owner.UID != os.Geteuid() || info.Mode&0o022 != 0 {
			return errors.New("gateway restart marker is not owned safely by this runtime")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return errors.New("gateway restart marker could not be read")
		}
		if _, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data))); err != nil {
			return errors.New("gateway restart marker has an invalid timestamp")
		}
		return nil
	}
	body := []byte(time.Now().UTC().Format(time.RFC3339) + "\n")
	temp, err := os.CreateTemp(filepath.Dir(path), ".gateway-restart-*.tmp")
	if err != nil {
		return errors.New("gateway restart marker could not be prepared")
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chown(os.Geteuid(), os.Getegid()); err != nil {
		temp.Close()
		return errors.New("gateway restart marker owner could not be prepared")
	}
	if _, err := temp.Write(body); err != nil {
		temp.Close()
		return errors.New("gateway restart marker could not be stored")
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return errors.New("gateway restart marker could not be synced")
	}
	if err := temp.Close(); err != nil {
		return errors.New("gateway restart marker could not be closed")
	}
	// A hard link publishes a complete inode without replacing a marker that
	// another command has just published. Both paths are on the same filesystem.
	if err := os.Link(tempPath, path); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return errors.New("gateway restart marker could not be stored")
		}
		// The other writer won. Re-read its complete marker, without retrying a
		// missing or malformed result indefinitely.
		data, readErr := fsx.ReadRegular(path, 0o600, fsx.Current())
		if readErr != nil {
			return errors.New("concurrent gateway restart marker could not be verified")
		}
		if _, readErr := time.Parse(time.RFC3339, strings.TrimSpace(string(data))); readErr != nil {
			return errors.New("concurrent gateway restart marker has an invalid timestamp")
		}
		return nil
	}
	readback, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if err != nil || !bytes.Equal(body, readback) {
		return errors.New("gateway restart marker could not be verified")
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return errors.New("gateway restart marker directory could not be synced")
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return errors.New("gateway restart marker directory could not be synced")
	}
	return nil
}
