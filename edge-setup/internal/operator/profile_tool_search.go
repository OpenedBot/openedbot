package operator

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Hermes's Tool Search hides every MCP tool behind three bridge tools as soon
// as one exists. A profile whose only live MCP servers are openedbot's own
// pays one or two model round trips per scheduling call for nothing, so the
// inventory program writes `tools.tool_search.enabled: off` on it, and takes
// the key back once a third-party server or hosted connectors are live there
// (inventory_probe.py, `converge_tool_search`). Every profile config the
// program saves converges on the way; the calls below cover what it does not
// save itself: profiles already on disk when the operator starts (a host
// upgraded under existing bots), an MCP authorization, which the OAuth
// program saves, and a toolset batch, which Hermes saves.

// toolSearchBatch bounds one converge run (the program's own bound).
const toolSearchBatch = 256

// toolSearchConvergeTimeout bounds one run, the config locks included.
const toolSearchConvergeTimeout = 2 * time.Minute

// toolSearchConnectorsToolset is the hosted-connectors toolset: reachable
// only through the bridge, so turning it on or off moves the rule.
const toolSearchConnectorsToolset = "connections"

type toolSearchConvergence struct {
	Profiles []struct {
		Name    string `json:"name"`
		Changed bool   `json:"changed"`
		Managed bool   `json:"managed"`
		Error   string `json:"error"`
	} `json:"profiles"`
}

// convergeToolSearch runs the rule on the named profiles, under their config
// locks. A refusal is logged and returned; it never undoes the write that
// asked for it: an unconverged profile keeps Hermes's default or the value
// already written, both of which work.
func (s *Server) convergeToolSearch(ctx context.Context, profiles []string) error {
	if s.Probe == nil || len(profiles) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, toolSearchConvergeTimeout)
	defer cancel()
	var doc toolSearchConvergence
	if err := s.runProbe(ctx, "profile-tool-search-converge", map[string]any{"names": profiles}, &doc); err != nil {
		s.logf("tool search: converging %d profile(s) failed: %v", len(profiles), err)
		return err
	}
	for _, profile := range doc.Profiles {
		switch {
		case profile.Error != "":
			s.logf("tool search %s: not converged (%s)", profile.Name, profile.Error)
		case profile.Changed && profile.Managed:
			s.logf("tool search %s: off (openedbot's MCP servers only)", profile.Name)
		case profile.Changed:
			s.logf("tool search %s: back to the Hermes default", profile.Name)
		}
	}
	return nil
}

// ConvergeToolSearchOnStart converges every named profile on disk once. It
// runs beside the listener at operator start, which an upgrade triggers: a
// host upgraded under existing bots gets the rule without anyone touching
// them. A converged profile is not rewritten.
func (s *Server) ConvergeToolSearchOnStart(ctx context.Context) {
	profiles, err := toolSearchProfiles(s.InventoryRoots.RuntimeRoot)
	if err != nil {
		s.logf("tool search: the profiles could not be listed: %v", err)
		return
	}
	for batch := range slices.Chunk(profiles, toolSearchBatch) {
		if ctx.Err() != nil {
			return
		}
		_ = s.convergeToolSearch(ctx, batch)
	}
}

// convergeToolSearchAfterToolsets converges one profile after a toolset write
// that named the hosted-connectors toolset.
func (s *Server) convergeToolSearchAfterToolsets(ctx context.Context, profile string, names ...string) {
	if slices.Contains(names, toolSearchConnectorsToolset) {
		_ = s.convergeToolSearch(context.WithoutCancel(ctx), []string{profile})
	}
}

// toolSearchProfiles lists the named profiles that carry a config.yaml, by a
// name the routes would accept.
func toolSearchProfiles(runtimeRoot string) ([]string, error) {
	if runtimeRoot == "" {
		return nil, errors.New("the runtime root is not configured")
	}
	entries, err := os.ReadDir(filepath.Join(runtimeRoot, "profiles"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var profiles []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || !profileSlugRe.MatchString(name) || name == "default" {
			continue
		}
		info, err := os.Lstat(filepath.Join(runtimeRoot, "profiles", name, "config.yaml"))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		profiles = append(profiles, name)
	}
	return profiles, nil
}
