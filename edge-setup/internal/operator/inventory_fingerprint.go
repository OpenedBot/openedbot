package operator

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// InventoryRoots names the files that decide what the console's Connectors
// page shows: toolsets and MCP servers (config.yaml, .env), MCP logins
// (mcp-tokens) and installed skills (SKILL.md), for the runtime root and for
// every profile. Nothing else under HERMES_HOME is watched: sessions, logs,
// caches and databases change all the time and say nothing about the
// inventory.
type InventoryRoots struct {
	// RuntimeRoot is HERMES_HOME.
	RuntimeRoot string
	// ManagedConfig is merged over every profile's config.yaml ("" when the
	// host has none, as on macOS).
	ManagedConfig string
}

// Bounds of one fingerprint. A walk that reaches one of them still answers,
// with what it saw: the fingerprint is a change detector, not an inventory,
// and an unbounded walk would let a runaway skills tree stall the operator.
const (
	maxFingerprintEntries = 20_000
	maxSkillDepth         = 3
)

var errFingerprintBound = errors.New("inventory fingerprint bound reached")

// InventoryFingerprint hashes the name, size, mode and modification time of
// every watched file. It never reads a file's content: a .env holds secrets
// and its bytes have no business in a hash that leaves the host.
func InventoryFingerprint(roots InventoryRoots) (string, error) {
	all, _, err := inventoryFingerprints(roots)
	return all, err
}

// inventoryFingerprints is the fingerprint of everything watched, and the
// fingerprint of the root's part alone (its home and the managed config).
// The second one says whether a move touched the root or only profiles.
func inventoryFingerprints(roots InventoryRoots) (string, string, error) {
	entries, err := inventoryEntries(roots)
	all, err := finish(entries, err)
	if err != nil {
		return "", "", err
	}
	var rootEntries []string
	for _, entry := range entries {
		if strings.HasPrefix(entry, "root/") || strings.HasPrefix(entry, "managed/") {
			rootEntries = append(rootEntries, entry)
		}
	}
	root, _ := finish(rootEntries, nil)
	return all, root, nil
}

// inventoryEntries collects one line per watched file; a bound reached is
// returned with what was seen.
func inventoryEntries(roots InventoryRoots) ([]string, error) {
	if roots.RuntimeRoot == "" {
		return nil, errors.New("the runtime root is not configured")
	}
	var entries []string
	add := func(label, path string) error {
		if len(entries) >= maxFingerprintEntries {
			return errFingerprintBound
		}
		info, err := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) {
			entries = append(entries, label+"|absent")
			return nil
		}
		if err != nil {
			return err
		}
		entries = append(entries, fmt.Sprintf("%s|%d|%o|%d", label, info.Size(), info.Mode(), info.ModTime().UnixNano()))
		return nil
	}

	if roots.ManagedConfig != "" {
		if err := add("managed/config.yaml", roots.ManagedConfig); err != nil {
			return entries, err
		}
	}
	if err := addHome(add, "root", roots.RuntimeRoot); err != nil {
		return entries, err
	}
	profiles, err := os.ReadDir(filepath.Join(roots.RuntimeRoot, "profiles"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return entries, err
	}
	for _, profile := range profiles {
		if !profile.IsDir() || strings.HasPrefix(profile.Name(), ".") {
			continue
		}
		label := "profile/" + profile.Name()
		if err := addHome(add, label, filepath.Join(roots.RuntimeRoot, "profiles", profile.Name())); err != nil {
			return entries, err
		}
	}
	return entries, nil
}

// addHome adds the watched files of one Hermes home (the root or a profile).
func addHome(add func(label, path string) error, label, home string) error {
	for _, name := range []string{"config.yaml", ".env"} {
		if err := add(label+"/"+name, filepath.Join(home, name)); err != nil {
			return err
		}
	}
	tokens, err := os.ReadDir(filepath.Join(home, "mcp-tokens"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for _, token := range tokens {
		if err := add(label+"/mcp-tokens/"+token.Name(), filepath.Join(home, "mcp-tokens", token.Name())); err != nil {
			return err
		}
	}
	return addSkills(add, label+"/skills", filepath.Join(home, "skills"), 0)
}

// addSkills adds every SKILL.md of a skills tree (category/skill/SKILL.md, or
// skill/SKILL.md), skipping the dot directories Hermes keeps there (.hub
// indexes, curator backups, locks): they change without the inventory
// changing.
func addSkills(add func(label, path string) error, label, dir string, depth int) error {
	children, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, child := range children {
		name := child.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		path := filepath.Join(dir, name)
		if child.Type().IsRegular() && name == "SKILL.md" {
			if err := add(label+"/"+name, path); err != nil {
				return err
			}
			continue
		}
		// A symlinked directory is not followed: it could leave HERMES_HOME.
		if child.IsDir() && depth < maxSkillDepth {
			if err := addSkills(add, label+"/"+name, path, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// finish sorts and hashes what was collected. Reaching a bound is not an
// error; any other failure is, so the caller never mistakes an unreadable
// tree for an unchanged one.
func finish(entries []string, err error) (string, error) {
	if err != nil && !errors.Is(err, errFingerprintBound) {
		return "", err
	}
	sort.Strings(entries)
	sum := sha256.New()
	for _, entry := range entries {
		sum.Write([]byte(entry))
		sum.Write([]byte{0})
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// inventoryFingerprint serves GET /inventory/fingerprint. The connector polls
// it and tells openedbot when it moves, so the console's inventory snapshot is
// refreshed before anyone opens the page. A fingerprint that moved also drops
// this operator's own read cache: the change was made outside the operator
// (the CLI, a file copied by hand), which no write of ours has invalidated.
func (s *Server) inventoryFingerprint(w http.ResponseWriter, _ *http.Request) {
	if s.InventoryRoots.RuntimeRoot == "" {
		writeError(w, http.StatusNotFound, "INVENTORY_FINGERPRINT_UNAVAILABLE", "this host does not watch its inventory")
		return
	}
	fingerprint, rootFingerprint, err := inventoryFingerprints(s.InventoryRoots)
	if err != nil {
		s.logf("inventory fingerprint failed: %v", err)
		writeError(w, http.StatusInternalServerError, "INVENTORY_FINGERPRINT_FAILED", "the inventory fingerprint could not be computed")
		return
	}
	s.mu.Lock()
	moved := s.lastFingerprint != "" && s.lastFingerprint != fingerprint
	rootMoved := s.lastRootFingerprint != rootFingerprint
	s.lastFingerprint, s.lastRootFingerprint = fingerprint, rootFingerprint
	s.mu.Unlock()
	// A move under profiles only (a new bot's profile being written, a
	// profile edited by hand) leaves the root reads true: dropping them made
	// the next one pay a cold interpreter inside a provisioning (lab host,
	// 2026-11-02). A root move, or the managed config, drops everything.
	switch {
	case moved && rootMoved:
		s.dropReadCache()
	case moved:
		s.dropProfileReadCache()
	}
	writeJSON(w, http.StatusOK, map[string]string{"fingerprint": fingerprint})
}
