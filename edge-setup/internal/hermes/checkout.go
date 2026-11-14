package hermes

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// runtimeProbeArtefacts are the files the upstream runtime writes inside the
// managed checkout to decide whether it may install a Node bridge there
// (`scripts/whatsapp-bridge/.write_test`,
// `plugins/platforms/photon/sidecar/.hermes-write-probe`). They are untracked
// AND not ignored, and the Photon one is rewritten on every status probe: a
// crash between the create and the delete leaves the checkout dirty forever.
// Without this sweep `up` stops the gateway and resets the tree because of a
// zero-byte probe file.
var runtimeProbeArtefacts = []string{
	"scripts/whatsapp-bridge/.write_test",
	"plugins/platforms/photon/sidecar/.hermes-write-probe",
	"plugins/platforms/photon/sidecar/.photon-npm-error.log",
}

// maxRepairRoots bounds a single reclaim pass. A node_modules tree yields one
// root, so this is already generous; beyond it the proof rightly fails.
const maxRepairRoots = 64

// quarantineDir is where anything taken out of the checkout is kept. Nothing
// the client or the runtime put there is ever deleted: a bridge that took a
// week to pair must survive an `up`, and a silent `rm` is impossible to
// support afterwards.
func quarantineDir(root string, at time.Time) string {
	return filepath.Join(root, at.UTC().Format("20060102T150405Z"))
}

// ensureQuarantineRoot creates the pass directory and its parent root only.
// Quarantined content belongs to the client (a plugin, a paired bridge, a
// file with a token in it): fsx.EnsureDir makes parents traversable at 0755,
// so both levels are set here instead of relying on the leaf.
func ensureQuarantineRoot(quarantine string, owner fsx.Owner) error {
	if err := fsx.EnsureDir(filepath.Dir(quarantine), 0o700, owner); err != nil {
		return err
	}
	return fsx.EnsureDir(quarantine, 0o700, owner)
}

// sweepProbes moves the runtime's leftover write probes out of the checkout
// and returns what it moved, relative to the checkout.
func sweepProbes(checkout, quarantine string, owner fsx.Owner) ([]string, error) {
	var moved []string
	for _, rel := range runtimeProbeArtefacts {
		src := filepath.Join(checkout, rel)
		st, err := os.Lstat(src)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return moved, err
		}
		if !st.Mode().IsRegular() {
			continue
		}
		if len(moved) == 0 {
			if err := ensureQuarantineRoot(quarantine, owner); err != nil {
				return moved, err
			}
		}
		if err := quarantinePath(src, filepath.Join(quarantine, rel), owner); err != nil {
			return moved, err
		}
		moved = append(moved, rel)
	}
	return moved, nil
}

// quarantineUntracked preserves every untracked, non-ignored file of a dirty
// checkout before `git clean -ffd` removes it. Ignored build artefacts
// (node_modules) are not listed by `--untracked-files=all` with the upstream
// .gitignore, and `git clean` without `-x` leaves them alone: they stay in
// place and are reclaimed instead.
func quarantineUntracked(checkout, quarantine, porcelain string, owner fsx.Owner) ([]string, error) {
	paths := untrackedPaths(porcelain)
	if len(paths) == 0 {
		return nil, nil
	}
	if err := ensureQuarantineRoot(quarantine, owner); err != nil {
		return nil, err
	}
	manifest := "# edge-setup: git status --porcelain=v1 --untracked-files=all\n" + strings.TrimRight(porcelain, "\n") + "\n"
	if err := fsx.WriteAtomic(filepath.Join(quarantine, "git-status.txt"), []byte(manifest), 0o600, owner); err != nil {
		return nil, err
	}
	var moved []string
	for _, rel := range paths {
		src := filepath.Join(checkout, rel)
		if !fsx.Exists(src) {
			continue
		}
		if err := quarantinePath(src, filepath.Join(quarantine, rel), owner); err != nil {
			return moved, err
		}
		moved = append(moved, rel)
	}
	return moved, nil
}

// untrackedPaths reads the `??` entries of a porcelain v1 status. A path with
// a special character is quoted by git with C escapes.
func untrackedPaths(porcelain string) []string {
	var out []string
	for _, line := range strings.Split(porcelain, "\n") {
		rest, ok := strings.CutPrefix(line, "?? ")
		if !ok {
			continue
		}
		rest = strings.TrimSpace(rest)
		if rest == "" {
			continue
		}
		if strings.HasPrefix(rest, `"`) {
			unquoted, err := strconv.Unquote(rest)
			if err != nil {
				continue
			}
			rest = unquoted
		}
		out = append(out, strings.TrimSuffix(rest, "/"))
	}
	return out
}

// quarantinePath moves src under dst, renaming first and falling back to a
// copy when the quarantine lives on another filesystem.
func quarantinePath(src, dst string, owner fsx.Owner) error {
	if err := fsx.EnsureDir(filepath.Dir(dst), 0o700, owner); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyTree(src, dst); err != nil {
		return fmt.Errorf("quarantine %s: %w", src, err)
	}
	return os.RemoveAll(src)
}

// copyTree copies a file, a symlink or a directory, preserving the mode.
func copyTree(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case st.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	case st.IsDir():
		if err := os.MkdirAll(dst, st.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	case st.Mode().IsRegular():
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, st.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	default:
		// A socket or a device node is never a checkout artefact worth keeping.
		return nil
	}
}

// repairRoots reduces the paths a proof rejected to the shortest trees worth
// reclaiming: one `node_modules` yields its directory, not its 40 000 files.
func repairRoots(offenders []string, max int) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range offenders {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if idx := strings.Index(p, "/node_modules/"); idx >= 0 {
			p = p[:idx+len("/node_modules")]
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
		if len(out) == max {
			break
		}
	}
	return out
}
