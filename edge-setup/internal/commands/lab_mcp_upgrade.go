package commands

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

var labMCPAsset = regexp.MustCompile(`^lab-mcp-fixture-([0-9a-f]{16})\.py$`)

// Recover the original entry from an existing root-owned receipt without
// executing an older controller. The current controller only uses this path
// to compare or preserve the already-installed, nonce-owned profile entry.
func resolveLabMCPEntry(dir, current, entryHash, nonce string, owner fsx.Owner) (string, error) {
	if entryHash == labMCPEntryHash(current, nonce) {
		// Install verifies the current embedded asset before any worker is run.
		return current, nil
	}
	info, err := fsx.Lstat(dir)
	if err != nil || !info.Exists || !info.Dir || info.Symlink || info.Owner != owner || info.Mode&0o022 != 0 {
		return "", errors.New("the original fixture asset directory is unsafe")
	}
	handle, err := os.Open(dir)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	names, err := handle.Readdirnames(1025)
	if (err != nil && !errors.Is(err, io.EOF)) || len(names) > 1024 {
		return "", errors.New("cannot safely enumerate bounded fixture assets")
	}
	for _, name := range names {
		match := labMCPAsset.FindStringSubmatch(name)
		if match == nil {
			continue
		}
		path := filepath.Join(dir, name)
		if labMCPEntryHash(path, nonce) != entryHash {
			continue
		}
		asset, err := fsx.Lstat(path)
		if err != nil || asset.Size > 65536 {
			return "", errors.New("the original fixture asset exceeds its bound or is unavailable")
		}
		content, err := fsx.ReadRegular(path, 0o644, owner)
		if err != nil {
			return "", errors.New("the original fixture asset changed ownership or mode")
		}
		if len(content) > 65536 {
			return "", errors.New("the original fixture asset exceeds its bound")
		}
		sum := sha256.Sum256(content)
		if hex.EncodeToString(sum[:8]) != match[1] {
			return "", errors.New("the original fixture asset does not match its content address")
		}
		return path, nil
	}
	return "", errors.New("the original fixture asset is missing; retain its root-owned content-addressed script to recover this fixture")
}
