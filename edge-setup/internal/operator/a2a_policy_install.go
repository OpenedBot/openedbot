package operator

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/assets"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

var a2aAddonProfileName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

func installA2APolicyFilesIfPresent(runtimeRoot string, owner fsx.Owner) error {
	state, err := fsx.Lstat(runtimeRoot)
	if err != nil {
		return errors.New("A2A runtime home is unavailable")
	}
	if !state.Exists {
		return nil
	}
	return InstallA2APolicyFiles(runtimeRoot, owner)
}

// InstallA2APolicyFiles is an owner-side provisioning step. It installs only
// embedded fixed code; plugin enablement is separately verified upstream.
// Operator relay inputs never supply runtime homes or installation paths.
func InstallA2APolicyFiles(runtimeRoot string, owner fsx.Owner) error {
	if err := installA2APolicyHome(runtimeRoot, runtimeRoot, owner); err != nil {
		return err
	}
	profiles := filepath.Join(runtimeRoot, "profiles")
	state, err := fsx.Lstat(profiles)
	if err != nil {
		return errors.New("A2A managed profiles are unavailable")
	}
	if !state.Exists {
		return nil
	}
	if !state.Dir || state.Symlink || state.Owner != owner {
		return errors.New("A2A managed profile directory is unsafe")
	}
	entries, err := os.ReadDir(profiles)
	if err != nil || len(entries) > 1024 {
		return errors.New("A2A managed profile inventory is unavailable")
	}
	for _, entry := range entries {
		if !a2aAddonProfileName.MatchString(entry.Name()) {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("A2A managed profile directory is unsafe")
		}
		if !entry.IsDir() {
			continue
		}
		config := filepath.Join(profiles, entry.Name(), "config.yaml")
		configState, err := fsx.Lstat(config)
		if err != nil {
			return errors.New("A2A managed profile configuration is unavailable")
		}
		if !configState.Exists {
			continue
		}
		if valid, err := fsx.RequireRegular(config, 0, owner); err != nil || !valid {
			return errors.New("A2A managed profile configuration is unsafe")
		}
		if err := installA2APolicyHome(runtimeRoot, filepath.Join(profiles, entry.Name()), owner); err != nil {
			return err
		}
	}
	return nil
}

func installA2APolicyHome(runtimeRoot, activeHome string, owner fsx.Owner) error {
	if runtimeRoot == "" || !filepath.IsAbs(runtimeRoot) || filepath.Clean(runtimeRoot) != runtimeRoot || runtimeRoot == string(filepath.Separator) || owner.UID < 0 || owner.GID < 0 {
		return errors.New("A2A runtime home is invalid")
	}
	if activeHome != runtimeRoot && (filepath.Dir(activeHome) != filepath.Join(runtimeRoot, "profiles") || !a2aAddonProfileName.MatchString(filepath.Base(activeHome))) {
		return errors.New("A2A profile does not belong to the managed runtime")
	}
	if activeHome != runtimeRoot {
		profiles, err := fsx.Lstat(filepath.Join(runtimeRoot, "profiles"))
		if err != nil || !profiles.Exists || !profiles.Dir || profiles.Symlink || profiles.Owner != owner {
			return errors.New("A2A managed profile directory is unsafe")
		}
	}
	for _, home := range []string{runtimeRoot, activeHome} {
		state, err := fsx.Lstat(home)
		if err != nil || !state.Exists || !state.Dir || state.Symlink || state.Owner != owner {
			return errors.New("A2A runtime home is unsafe")
		}
	}
	files, err := assets.A2APolicyFiles()
	if err != nil {
		return errors.New("A2A companion files are unavailable")
	}
	if err := fsx.EnsureDirUnder(activeHome, filepath.Join(activeHome, "plugins"), 0o700, owner); err != nil {
		return errors.New("A2A companion directory is unsafe")
	}
	for source, contents := range files {
		var relative string
		if strings.HasPrefix(source, "hermes-plugins/") {
			relative = "plugins/" + strings.TrimPrefix(source, "hermes-plugins/")
		} else if strings.HasPrefix(source, "hermes-hooks/") {
			// Only the runtime root owns the gateway startup event.
			if activeHome != runtimeRoot {
				continue
			}
			relative = "hooks/" + strings.TrimPrefix(source, "hermes-hooks/")
		} else {
			return errors.New("A2A companion inventory is invalid")
		}
		target := filepath.Join(activeHome, filepath.FromSlash(relative))
		if err := fsx.EnsureDirUnder(activeHome, filepath.Dir(target), 0o700, owner); err != nil {
			return errors.New("A2A companion directory is unsafe")
		}
		if err := fsx.WriteAtomic(target, contents, 0o600, owner); err != nil {
			return errors.New("A2A companion file could not be installed safely")
		}
	}
	marker := filepath.Join(activeHome, "plugins", "ohb_a2a_policy", "runtime-home")
	if err := fsx.WriteAtomic(marker, []byte(runtimeRoot+"\n"), 0o600, owner); err != nil {
		return errors.New("A2A runtime binding could not be installed safely")
	}
	return nil
}
