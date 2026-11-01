package hermes

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// writeInstallStamp writes the managed-install provenance format consumed by
// Hermes' version_info resolver. edge-setup owns dependency installation;
// declaring "self" would make Hermes try to provision its separate PM store.
func writeInstallStamp(path string, owner fsx.Owner) error {
	if err := ignoreInstallStamp(filepath.Dir(path), owner); err != nil {
		return err
	}
	stamp := map[string]any{
		"schemaVersion":   2,
		"commit":          pins.HermesInstallerCommit,
		"commitDate":      nil,
		"branch":          pins.HermesInstallerBranch,
		"builtAt":         time.Now().UTC().Format(time.RFC3339Nano),
		"dirty":           false,
		"source":          "local",
		"distribution":    nil,
		"updateMechanism": "external",
		"baseVersion":     pins.HermesVersion,
		"displayVersion":  pins.HermesVersion,
		"distance":        0,
		"payload":         "bootstrap",
		"tag":             nil,
	}
	data, err := json.MarshalIndent(stamp, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return fsx.WriteAtomic(path, data, 0o644, owner)
}

// ignoreInstallStamp keeps provenance beside the executing tree, the default
// location in upstream pm.paths. A checkout-local exclusion also works after
// rolling back to a pin whose .gitignore predates stamps. It hides only this
// untracked root file, never tracked modifications or other untracked files.
func ignoreInstallStamp(checkout string, owner fsx.Owner) error {
	info := filepath.Join(checkout, ".git", "info")
	if err := fsx.EnsureDirUnder(checkout, info, 0o755, owner); err != nil {
		return err
	}
	path := filepath.Join(info, "exclude")
	data, err := fsx.ReadRegular(path, 0, owner)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	const rule = "/install-stamp.json"
	for _, line := range strings.Split(string(data), "\n") {
		if line == rule {
			return nil
		}
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, rule+"\n"...)
	return fsx.WriteAtomic(path, data, 0o644, owner)
}

func prepareVersionHome(path string, owner fsx.Owner) error {
	if err := fsx.EnsureDir(path, 0o700, owner); err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(path, "config.yaml"), []byte("updates:\n  check: false\n"), 0o600, owner)
}

// ServiceOwner is the uid:gid of the runtime service account, or {-1,-1} when
// the account does not exist yet (first install) or cannot be read.
func ServiceOwner() fsx.Owner {
	u, err := user.Lookup(layout.ServiceUser)
	if err != nil {
		return fsx.Owner{UID: -1, GID: -1}
	}
	uid, uerr := strconv.Atoi(u.Uid)
	gid, gerr := strconv.Atoi(u.Gid)
	if uerr != nil || gerr != nil {
		return fsx.Owner{UID: -1, GID: -1}
	}
	return fsx.Owner{UID: uid, GID: gid}
}

// TightenSecretFile puts a runtime secret back to 0600 and, when the owner is
// known, to that owner. A mode nobody meant to change is repaired instead of
// ending the pass: refusing on it used to strand a host, because the same
// refusal also stopped the rollback that would have undone the upgrade.
// A missing file is not an error; a symlink or a non-regular file still is.
// The runtime user can rewrite the directory this file sits in, so the mode
// and the owner are applied through a descriptor opened without following a
// symlink (fsx.TightenFile), never through the path.
func TightenSecretFile(path string, owner fsx.Owner, log func(string, ...any)) error {
	return fsx.TightenFile(path, 0o600, owner, log)
}

// ReconcileCheckout repairs what the runtime leaves behind in the managed
// checkout: write probes are quarantined, build artefacts are made root-owned
// again, and the ownership invariant is proven.
//
// It is offline and bounded: no git, no network, no unit stopped. `upgrade`
// calls it so a host that `up` refuses (a bridge's node_modules owned by the
// service user) is repaired by the very release that fixes the problem.
// Without it, only `up` touches the checkout, and a host that `up` rejects
// can never receive the fix for the reason it is rejected.
func ReconcileCheckout(ctx context.Context, r exec.Runner, log func(string, ...any)) error {
	if log == nil {
		log = func(string, ...any) {}
	}
	st, err := fsx.Lstat(layout.InstallDir)
	if err != nil {
		return err
	}
	if !st.Exists || !st.Dir || st.Symlink {
		return nil
	}
	i := &Installer{Runner: r, Log: log}
	if err := i.sweepRuntimeProbes(); err != nil {
		return err
	}
	return i.requireRootOwnedSource(ctx, false)
}
