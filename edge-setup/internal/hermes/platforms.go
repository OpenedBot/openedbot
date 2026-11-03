package hermes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// nodeBridge is one upstream platform whose sidecar is a Node program.
//
// The upstream runtime installs these dependencies itself, at connect time,
// with `npm install` inside the checkout. Under edge-setup the checkout is
// root-owned, so the runtime falls back to a copy under HERMES_HOME, and both
// fallbacks are broken upstream: the WhatsApp copy is made once and never
// refreshed (`resolve_whatsapp_bridge_dir` returns early when it exists), so
// a Hermes bump leaves an old bridge against a new adapter; the Photon copy
// lists four files and misses two its entry point imports.
//
// So the mirror is made here, refreshed by content, with every file the
// sidecar needs, and its dependencies are installed before the platform is
// ever used. The gateway then finds them in place and never reaches npm on a
// user's first message.
type nodeBridge struct {
	name string
	// source is under the managed checkout, mirror under HERMES_HOME.
	source, mirror string
	// stamp, when set, is the marker the adapter reads to decide the
	// dependencies match package.json (first 16 hex of its SHA-256).
	stamp string
}

func nodeBridges() []nodeBridge {
	return []nodeBridge{
		{
			name:   "whatsapp",
			source: layout.InstallDir + "/scripts/whatsapp-bridge",
			mirror: layout.RuntimeRoot + "/scripts/whatsapp-bridge",
			stamp:  "node_modules/.hermes-pkg-hash",
		},
		{
			name:   "photon",
			source: layout.InstallDir + "/plugins/platforms/photon/sidecar",
			mirror: layout.RuntimeRoot + "/photon/sidecar",
		},
	}
}

// preparePlatforms mirrors the Node bridges and installs their dependencies.
// It runs after the gateway is up and reports what it could not do: npm being
// unreachable costs a platform, never an installation. Every return value is
// a warning, never an error.
func (i *Installer) preparePlatforms(ctx context.Context, info *account.Info) []string {
	var warnings []string
	if i.nodeVersion(ctx) == "" {
		return []string{"no managed Node: the WhatsApp and Photon bridges cannot be prepared"}
	}
	owner := fsx.Owner{UID: info.UID, GID: info.GID}
	for _, b := range nodeBridges() {
		if !fsx.Exists(b.source) {
			continue
		}
		if warning := i.prepareBridge(ctx, b, owner); warning != "" {
			warnings = append(warnings, warning)
		}
	}
	return warnings
}

// depsMarker sits in the mirror, outside node_modules, and is written only
// once `npm ci` has succeeded. node_modules existing proves nothing: npm ci
// creates it before it can fail, and a pass that trusted it would never
// retry a broken install.
const depsMarker = ".ohb-deps-ok"

// prepareBridge mirrors one bridge and installs its dependencies unless the
// marker vouches for them. It returns a warning, or "" when the bridge is ready.
func (i *Installer) prepareBridge(ctx context.Context, b nodeBridge, owner fsx.Owner) string {
	changed, err := mirrorBridge(b.source, b.mirror, owner)
	if err != nil {
		return fmt.Sprintf("%s bridge not mirrored: %v", b.name, err)
	}
	want, err := depsFingerprint(b.mirror)
	if err != nil {
		return fmt.Sprintf("%s bridge dependencies not installed: %v", b.name, err)
	}
	marker := filepath.Join(b.mirror, depsMarker)
	if got, err := os.ReadFile(marker); !changed && err == nil && strings.TrimSpace(string(got)) == want {
		return ""
	}
	// npm ci wipes node_modules first: a marker left from an older success
	// would vouch for a tree this attempt may leave half-installed.
	if err := fsx.Remove(marker); err != nil {
		return fmt.Sprintf("%s bridge dependencies not installed: %v", b.name, err)
	}
	if err := i.installBridgeDeps(ctx, b, owner); err != nil {
		return fmt.Sprintf("%s bridge dependencies not installed: %v", b.name, err)
	}
	if err := fsx.WriteAtomic(marker, []byte(want+"\n"), 0o600, owner); err != nil {
		return fmt.Sprintf("%s bridge dependencies not recorded: %v", b.name, err)
	}
	i.Log("%s bridge ready at %s", b.name, b.mirror)
	return ""
}

// depsFingerprint is the SHA-256 of what `npm ci` installs from: the
// lockfile, or package.json when the bridge ships none.
func depsFingerprint(mirror string) (string, error) {
	data, err := os.ReadFile(filepath.Join(mirror, "package-lock.json"))
	if errors.Is(err, fs.ErrNotExist) {
		data, err = os.ReadFile(filepath.Join(mirror, "package.json"))
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// installBridgeDeps runs `npm ci` in the mirror as the service user, which is
// the only account that may write there. Lifecycle scripts are NOT disabled:
// the Photon sidecar needs its postinstall (native bindings and a patch), and
// a sidecar installed with `--ignore-scripts` fails to load at all.
func (i *Installer) installBridgeDeps(ctx context.Context, b nodeBridge, owner fsx.Owner) error {
	cmd := account.AsUser(layout.ServiceUser,
		[]string{"HOME=" + layout.RuntimeRoot + "/home", "PATH=" + layout.NodeBin + ":/usr/bin:/bin"},
		layout.NodeBin+"/npm", "ci", "--no-audit", "--no-fund")
	cmd.Dir = b.mirror
	// npm answers an unreachable registry after roughly a minute, with a
	// message about npm itself rather than the network: bound it here so a
	// pass is never held for the default timeout on a platform nobody uses.
	cmd.Timeout = 10 * time.Minute
	if _, err := exec.Must(ctx, i.Runner, cmd); err != nil {
		return err
	}
	if b.stamp == "" {
		return nil
	}
	// The adapter reinstalls unless this marker matches package.json; writing
	// it is what keeps `npm install` out of the first message's latency.
	data, err := os.ReadFile(filepath.Join(b.mirror, "package.json"))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	return fsx.WriteAtomic(filepath.Join(b.mirror, b.stamp), []byte(hex.EncodeToString(sum[:])[:16]), 0o600, owner)
}

// mirrorBridge copies the sidecar sources into a directory the service user
// owns, comparing contents so an unchanged file is left alone, and reports
// whether anything changed. node_modules is never copied: it belongs to the
// mirror and is installed there.
func mirrorBridge(source, mirror string, owner fsx.Owner) (bool, error) {
	entries, err := os.ReadDir(source)
	if err != nil {
		return false, err
	}
	if err := fsx.EnsureDir(mirror, 0o750, owner); err != nil {
		return false, err
	}
	changed := false
	for _, e := range entries {
		if e.IsDir() || e.Name() == "node_modules" {
			continue
		}
		src := filepath.Join(source, e.Name())
		want, err := os.ReadFile(src)
		if err != nil {
			return changed, err
		}
		dst := filepath.Join(mirror, e.Name())
		if got, err := os.ReadFile(dst); err == nil && string(got) == string(want) {
			continue
		}
		if err := fsx.WriteAtomic(dst, want, 0o640, owner); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}
