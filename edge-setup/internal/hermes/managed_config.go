package hermes

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// ManagedConfig is the whole of Hermes' managed-scope config.yaml
// (hermes_cli/managed_scope.py). Hermes deep-merges it ON TOP of every
// profile's own config.yaml, at every load: unlike a key written to the root
// config, which reaches only the profiles cloned after it, it covers the bots
// that already exist. Hermes re-reads it on its file signature, so a change
// needs no gateway restart.
//
// prompt_caching.cache_ttl: the 5-minute default re-writes the whole cached
// prefix (~16k tokens) whenever an operator answers after a pause. "auto"
// gives an API run, which a person paces, the 1h tier (2x base input instead
// of 1.25x per write) and every machine-paced call Hermes makes on its own
// (compaction, auxiliary calls, delegated children) the 5m tier: a fixed
// "1h" would bill those twice for a prefix nobody reads again. A run that
// openedbot knows to be machine-paced (a routine, a delegated step, a
// greeting) asks for 5m itself (hook openedbot_prompt_cache_ttl).
const ManagedConfig = `# Written by edge-setup: Hermes managed scope, merged over every profile.
# Edits here are replaced on the next "edge-setup up" or "upgrade".
prompt_caching:
  cache_ttl: auto
`

// ManagedConfigPath and ManagedConfigOwner are variables only so that tests
// of `up` and `upgrade` write under a temporary directory.
var (
	ManagedConfigPath  = layout.ManagedConfig
	ManagedConfigOwner = fsx.Owner{UID: 0, GID: 0}
)

// ApplyManagedDefaults writes ManagedConfig when it differs. The file is
// root-owned and world-readable: it holds no secret and the gateway reads
// it as the service user.
func ApplyManagedDefaults(log func(string, ...any)) (bool, error) {
	return applyManagedDefaultsAt(ManagedConfigPath, ManagedConfigOwner, log)
}

func applyManagedDefaultsAt(path string, owner fsx.Owner, log func(string, ...any)) (bool, error) {
	current, err := os.ReadFile(path)
	if err == nil && bytes.Equal(current, []byte(ManagedConfig)) {
		return false, nil
	}
	if err != nil && !os.IsNotExist(err) {
		return false, fmt.Errorf("managed config: %w", err)
	}
	if err := fsx.EnsureDir(filepath.Dir(path), 0o755, owner); err != nil {
		return false, fmt.Errorf("managed config: %w", err)
	}
	if err := fsx.WriteAtomic(path, []byte(ManagedConfig), 0o644, owner); err != nil {
		return false, fmt.Errorf("managed config: %w", err)
	}
	if log != nil {
		log("Hermes managed scope: %s (prompt cache TTL auto)", path)
	}
	return true, nil
}
