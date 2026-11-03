package hermes

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

var dotenvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var profileName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ProfileOwnMarker is written next to a key that a named profile owns. The
// root→profile credential mirror must never overwrite those keys.
const ProfileOwnMarker = "ohb:profile-own"

const profileOwnFile = ".env.ohb-own"

// EnvStore binds credential snapshots and mirrors to one runtime root and
// owner. It is intended for callers that manage runtimes outside the legacy
// Linux service layout. Existing package-level helpers retain their original
// signatures and behavior. Wrappers without an explicit root use
// layout.RuntimeRoot and the service account.
type EnvStore struct {
	Root  string
	Owner fsx.Owner
}

// SnapshotRootEnv reads the root runtime .env using this store's root and
// owner. A missing file is an empty snapshot. Existing files must be regular,
// mode 0600, and owned by the configured runtime owner.
func (s EnvStore) SnapshotRootEnv() (map[string]string, error) {
	root, exists, err := s.rootDir()
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]string{}, nil
	}
	data, err := s.readEnv(filepath.Join(root, ".env"))
	if err != nil {
		return nil, err
	}
	return parseDotEnv(data), nil
}

// SnapshotProfileEnv reads one named profile's .env using this store's root
// and owner. A missing profile or file is an empty snapshot.
func (s EnvStore) SnapshotProfileEnv(profile string) (map[string]string, error) {
	if !profileName.MatchString(profile) || profile == "default" {
		return nil, fmt.Errorf("profile environment slug is invalid")
	}
	root, exists, err := s.rootDir()
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]string{}, nil
	}
	profiles := filepath.Join(root, "profiles")
	exists, err = storeDirectoryExists(profiles)
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]string{}, nil
	}
	profileDir := filepath.Join(profiles, profile)
	exists, err = storeDirectoryExists(profileDir)
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]string{}, nil
	}
	data, err := s.readEnv(filepath.Join(profileDir, ".env"))
	if err != nil {
		return nil, err
	}
	return parseDotEnv(data), nil
}

// MirrorRuntimeEnvDelta copies changed root provider credentials to each
// valid named profile while preserving profile-owned keys. API_SERVER_KEY is
// deliberately excluded. Existing profile env and ownership-marker files
// must be regular, mode 0600, and owned by this store's configured owner.
func (s EnvStore) MirrorRuntimeEnvDelta(before, after map[string]string) error {
	changes := dotenvDelta(before, after)
	if len(changes) == 0 {
		return nil
	}
	root, exists, err := s.rootDir()
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	profilesDir := filepath.Join(root, "profiles")
	exists, err = storeDirectoryExists(profilesDir)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	entries, err := os.ReadDir(profilesDir)
	if err != nil {
		return fmt.Errorf("list profile environments: %w", err)
	}
	keys := sortedChangeKeys(changes)
	for _, entry := range entries {
		if !profileName.MatchString(entry.Name()) || entry.Name() == "default" {
			continue
		}
		profileDir := filepath.Join(profilesDir, entry.Name())
		info, err := os.Lstat(profileDir)
		if err != nil {
			return fmt.Errorf("inspect profile environment: %w", err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		own, err := s.readProfileOwnKeys(profileDir)
		if err != nil {
			return err
		}
		filtered := map[string]dotenvChange{}
		filteredKeys := make([]string, 0, len(keys))
		for _, key := range keys {
			if own[key] {
				continue
			}
			filtered[key] = changes[key]
			filteredKeys = append(filteredKeys, key)
		}
		if len(filtered) == 0 {
			continue
		}
		path := filepath.Join(profileDir, ".env")
		data, err := s.readEnv(path)
		if err != nil {
			return err
		}
		updated, err := updateDotEnv(data, filtered, filteredKeys)
		if err != nil {
			return fmt.Errorf("prepare profile environment: %w", err)
		}
		if err := fsx.WriteAtomic(path, updated, 0o600, s.Owner); err != nil {
			return err
		}
	}
	return nil
}

// PreserveOwnProfileKeys marks changed, non-deleted keys as profile-owned so
// later root credential mirrors leave them untouched.
func (s EnvStore) PreserveOwnProfileKeys(profile string, before, after map[string]string) error {
	if !profileName.MatchString(profile) || profile == "default" {
		return fmt.Errorf("profile environment slug is invalid")
	}
	changes := dotenvDelta(before, after)
	if len(changes) == 0 {
		return nil
	}
	root, exists, err := s.rootDir()
	if err != nil {
		return err
	}
	if !exists {
		return fs.ErrNotExist
	}
	profilesDir := filepath.Join(root, "profiles")
	exists, err = storeDirectoryExists(profilesDir)
	if err != nil {
		return err
	}
	if !exists {
		return fs.ErrNotExist
	}
	profileDir := filepath.Join(profilesDir, profile)
	exists, err = storeDirectoryExists(profileDir)
	if err != nil {
		return err
	}
	if !exists {
		return fs.ErrNotExist
	}
	if _, err := s.readProfileOwnKeys(profileDir); err != nil {
		return err
	}
	keys := make([]string, 0, len(changes))
	for key, change := range changes {
		if change.deleted {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return s.markProfileOwnKeys(profileDir, keys)
}

func (s EnvStore) rootDir() (string, bool, error) {
	if s.Root == "" || !filepath.IsAbs(s.Root) || filepath.Clean(s.Root) == string(filepath.Separator) {
		return "", false, fmt.Errorf("runtime environment root is invalid")
	}
	if s.Owner.UID < 0 || s.Owner.GID < 0 {
		return "", false, fmt.Errorf("runtime environment owner is invalid")
	}
	root := filepath.Clean(s.Root)
	exists, err := storeDirectoryExists(root)
	return root, exists, err
}

func storeDirectoryExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect runtime environment path: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("runtime environment path is not a directory")
	}
	return true, nil
}

// readEnv reads an env file the store owns: regular, mode 0600, owned by the
// configured owner. The service user can rewrite the directory it sits in, so
// the check and the read are one step on one descriptor (fsx.ReadRegular), not
// a check followed by a read of the name. A missing file reads as empty.
func (s EnvStore) readEnv(path string) ([]byte, error) {
	data, err := fsx.ReadRegular(path, 0o600, s.Owner)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (s EnvStore) readProfileOwnKeys(profileDir string) (map[string]bool, error) {
	own := map[string]bool{}
	marker, err := s.readEnv(filepath.Join(profileDir, profileOwnFile))
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(marker), "\n") {
		key := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "#"))
		if dotenvKey.MatchString(key) {
			own[key] = true
		}
	}
	env, err := s.readEnv(filepath.Join(profileDir, ".env"))
	if err != nil {
		return nil, err
	}
	pending := false
	for _, line := range strings.Split(string(env), "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if strings.Contains(trimmed, ProfileOwnMarker) && strings.HasPrefix(trimmed, "#") {
			pending = true
			continue
		}
		key, _, ok := dotenvLine(trimmed)
		if ok && (pending || strings.Contains(trimmed, ProfileOwnMarker)) {
			own[key] = true
		}
		pending = false
	}
	return own, nil
}

func (s EnvStore) markProfileOwnKeys(profileDir string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	own, err := s.readProfileOwnKeys(profileDir)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if dotenvKey.MatchString(key) {
			own[key] = true
		}
	}
	names := make([]string, 0, len(own))
	for key := range own {
		names = append(names, key)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, key := range names {
		b.WriteString("# ")
		b.WriteString(ProfileOwnMarker)
		b.WriteByte('\n')
		b.WriteString(key)
		b.WriteByte('\n')
	}
	return fsx.WriteAtomic(filepath.Join(profileDir, profileOwnFile), []byte(b.String()), 0o600, s.Owner)
}

func sortedChangeKeys(changes map[string]dotenvChange) []string {
	keys := make([]string, 0, len(changes))
	for key := range changes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// SnapshotRuntimeEnv reads the runtime .env as key/value pairs. A missing
// file is an empty snapshot; a symlink or malformed file is refused before a
// credential operation can leave profile copies out of sync.
func SnapshotRuntimeEnv() (map[string]string, error) {
	return readDotEnv(filepath.Join(layout.RuntimeRoot, ".env"))
}

// MirrorRuntimeEnvDelta copies every changed non-runtime key from the root
// provider environment to every named profile. API_SERVER_KEY is deliberately
// excluded: named profiles must carry their own bearer and must never inherit
// the root gateway key.
func MirrorRuntimeEnvDelta(before, after map[string]string) error {
	if len(dotenvDelta(before, after)) == 0 {
		return nil
	}
	owner, err := serviceOwner()
	if err != nil {
		return err
	}
	return MirrorDotEnvDelta(layout.RuntimeRoot, before, after, owner)
}

// MirrorDotEnvDelta is the testable implementation of credential mirroring.
// root is the Hermes home and owner is the service account that must own each
// resulting profile .env.
func MirrorDotEnvDelta(root string, before, after map[string]string, owner fsx.Owner) error {
	changes := dotenvDelta(before, after)
	if len(changes) == 0 {
		return nil
	}
	profilesDir := filepath.Join(root, "profiles")
	entries, err := os.ReadDir(profilesDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("list profile environments: %w", err)
	}
	keys := make([]string, 0, len(changes))
	for key := range changes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !profileName.MatchString(entry.Name()) {
			continue
		}
		own, err := readProfileOwnKeys(filepath.Join(profilesDir, entry.Name()))
		if err != nil {
			return err
		}
		filtered := map[string]dotenvChange{}
		filteredKeys := make([]string, 0, len(keys))
		for _, key := range keys {
			if own[key] {
				continue
			}
			filtered[key] = changes[key]
			filteredKeys = append(filteredKeys, key)
		}
		if len(filtered) == 0 {
			continue
		}
		path := filepath.Join(profilesDir, entry.Name(), ".env")
		data, err := readDotEnvBytes(path)
		if err != nil {
			return err
		}
		updated, err := updateDotEnv(data, filtered, filteredKeys)
		if err != nil {
			return fmt.Errorf("prepare profile environment: %w", err)
		}
		if err := fsx.WriteAtomic(path, updated, 0o600, owner); err != nil {
			return err
		}
	}
	return nil
}

// SnapshotNamedProfileEnv reads the named profile's .env under the runtime root.
func SnapshotNamedProfileEnv(profile string) (map[string]string, error) {
	return SnapshotProfileEnv(layout.RuntimeRoot, profile)
}

// SnapshotProfileEnv reads one named profile's .env. A missing file is an
// empty snapshot; a symlink is refused.
func SnapshotProfileEnv(root, profile string) (map[string]string, error) {
	if !profileName.MatchString(profile) || profile == "default" {
		return nil, fmt.Errorf("profile environment slug is invalid")
	}
	return readDotEnv(filepath.Join(root, "profiles", profile, ".env"))
}

// MarkNamedProfileOwnEnvDelta records changed keys as profile-owned on the host.
func MarkNamedProfileOwnEnvDelta(profile string, before, after map[string]string) error {
	if len(dotenvDelta(before, after)) == 0 {
		return nil
	}
	owner, err := serviceOwner()
	if err != nil {
		return err
	}
	return MarkProfileOwnEnvDelta(layout.RuntimeRoot, profile, before, after, owner)
}

// MarkProfileOwnEnvDelta records every non-runtime key that changed in a
// named profile's .env as owned by that profile, so a later root credential
// mirror will not overwrite it.
func MarkProfileOwnEnvDelta(root, profile string, before, after map[string]string, owner fsx.Owner) error {
	if !profileName.MatchString(profile) || profile == "default" {
		return fmt.Errorf("profile environment slug is invalid")
	}
	changes := dotenvDelta(before, after)
	if len(changes) == 0 {
		return nil
	}
	keys := make([]string, 0, len(changes))
	for key, change := range changes {
		if change.deleted {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return markProfileOwnKeys(filepath.Join(root, "profiles", profile), keys, owner)
}

func readProfileOwnKeys(profileDir string) (map[string]bool, error) {
	own := map[string]bool{}
	data, err := readDotEnvBytes(filepath.Join(profileDir, profileOwnFile))
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		key := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "#"))
		if dotenvKey.MatchString(key) {
			own[key] = true
		}
	}
	env, err := readDotEnvBytes(filepath.Join(profileDir, ".env"))
	if err != nil {
		return nil, err
	}
	pending := false
	for _, line := range strings.Split(string(env), "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if strings.Contains(trimmed, ProfileOwnMarker) && strings.HasPrefix(trimmed, "#") {
			pending = true
			continue
		}
		key, _, ok := dotenvLine(trimmed)
		if ok && (pending || strings.Contains(trimmed, ProfileOwnMarker)) {
			own[key] = true
		}
		pending = false
	}
	return own, nil
}

func markProfileOwnKeys(profileDir string, keys []string, owner fsx.Owner) error {
	if len(keys) == 0 {
		return nil
	}
	own, err := readProfileOwnKeys(profileDir)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if dotenvKey.MatchString(key) {
			own[key] = true
		}
	}
	names := make([]string, 0, len(own))
	for key := range own {
		names = append(names, key)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, key := range names {
		b.WriteString("# ")
		b.WriteString(ProfileOwnMarker)
		b.WriteByte('\n')
		b.WriteString(key)
		b.WriteByte('\n')
	}
	return fsx.WriteAtomic(filepath.Join(profileDir, profileOwnFile), []byte(b.String()), 0o600, owner)
}

type dotenvChange struct {
	value   string
	deleted bool
}

func dotenvDelta(before, after map[string]string) map[string]dotenvChange {
	changes := map[string]dotenvChange{}
	for key, value := range after {
		if key == "API_SERVER_KEY" {
			continue
		}
		if old, ok := before[key]; !ok || old != value {
			changes[key] = dotenvChange{value: value}
		}
	}
	for key := range before {
		if key == "API_SERVER_KEY" {
			continue
		}
		if _, ok := after[key]; !ok {
			changes[key] = dotenvChange{deleted: true}
		}
	}
	return changes
}

func readDotEnv(path string) (map[string]string, error) {
	data, err := readDotEnvBytes(path)
	if err != nil {
		return nil, err
	}
	return parseDotEnv(data), nil
}

// readDotEnvBytes reads an env file as root during a credential operation. The
// service user can replace the file, so it is opened without following a
// symlink and read from that descriptor (fsx.ReadFile): a name swapped for a
// link to a root-only file after a check must never be read, and its lines
// must never be mirrored into a file the service user can read. A missing file
// reads as empty; a symlink or any other file that is not regular is refused.
func readDotEnvBytes(path string) ([]byte, error) {
	data, err := fsx.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func parseDotEnv(data []byte) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := dotenvLine(line)
		if !ok {
			continue
		}
		values[key] = value
	}
	return values
}

func dotenvLine(line string) (string, string, bool) {
	line = strings.TrimSuffix(line, "\r")
	trimmed := strings.TrimSpace(line)
	if strings.HasPrefix(trimmed, "export ") {
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "export "))
	}
	if strings.HasPrefix(trimmed, "#") {
		return "", "", false
	}
	i := strings.IndexByte(trimmed, '=')
	if i <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(trimmed[:i])
	if !dotenvKey.MatchString(key) {
		return "", "", false
	}
	return key, trimmed[i+1:], true
}

func updateDotEnv(data []byte, changes map[string]dotenvChange, keys []string) ([]byte, error) {
	lines := strings.SplitAfter(string(data), "\n")
	out := make([]string, 0, len(lines)+len(keys))
	seen := map[string]bool{}
	for _, line := range lines {
		if line == "" {
			continue
		}
		key, _, ok := dotenvLine(line)
		change, changed := changes[key]
		if ok && changed {
			seen[key] = true
			if change.deleted {
				continue
			}
			out = append(out, key+"="+change.value+"\n")
			continue
		}
		out = append(out, line)
	}
	for _, key := range keys {
		change := changes[key]
		if seen[key] || change.deleted {
			continue
		}
		out = append(out, key+"="+change.value+"\n")
	}
	return []byte(strings.Join(out, "")), nil
}

func serviceOwner() (fsx.Owner, error) {
	u, err := user.Lookup(layout.ServiceUser)
	if err != nil {
		return fsx.Owner{}, fmt.Errorf("lookup service user: %w", err)
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return fsx.Owner{}, fmt.Errorf("service user uid: %w", err)
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return fsx.Owner{}, fmt.Errorf("service user gid: %w", err)
	}
	return fsx.Owner{UID: uid, GID: gid}, nil
}
