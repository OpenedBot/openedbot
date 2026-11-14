package commands

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
)

const macUpgradeJournalLimit = 256 << 10

type macUpgradeBackup struct {
	Mode    fs.FileMode `json:"mode"`
	Present bool        `json:"present"`
	SHA256  string      `json:"sha256"`
}

// Target paths are derived from the managed runtime, never from this file.
type macUpgradeJournal struct {
	Schema                 int                `json:"schema"`
	ID                     string             `json:"id"`
	Phase                  string             `json:"phase"`
	OldVersion             string             `json:"old_version"`
	Request                macUpgradeRequest  `json:"request"`
	Snapshots              []macUpgradeBackup `json:"snapshots"`
	Terminal               []macUpgradeBackup `json:"terminal,omitempty"`
	ServicesMayHaveChanged bool               `json:"services_may_have_changed"`
}

func macUpgradeJournalPath(p layout.MacRuntimePaths) string {
	return filepath.Join(p.AppRoot, "upgrade-journal.json")
}

func macUpgradeBackupName(index int) string { return fmt.Sprintf("%03d", index) }

func macUpgradeCheckpoint(deps macUpgradeDeps, name string) {
	if deps.Checkpoint != nil {
		deps.Checkpoint(name)
	}
}

func backupDescription(snapshots []macUpgradeSnapshot) []macUpgradeBackup {
	result := make([]macUpgradeBackup, len(snapshots))
	for i, snapshot := range snapshots {
		result[i] = macUpgradeBackup{Mode: snapshot.Mode, Present: snapshot.Present}
		if snapshot.Present {
			result[i].SHA256 = selfupdate.Digest(snapshot.Data)
		}
	}
	return result
}

func newMacUpgradeJournal(snapshots []macUpgradeSnapshot, request macUpgradeRequest, oldVersion string) (*macUpgradeJournal, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, errors.New("macOS upgrade transaction identity is unavailable")
	}
	return &macUpgradeJournal{Schema: 1, ID: hex.EncodeToString(id), Phase: "preparing", OldVersion: oldVersion,
		Request: request, Snapshots: backupDescription(snapshots)}, nil
}

func writeMacUpgradeJournal(p layout.MacRuntimePaths, journal *macUpgradeJournal) error {
	data, err := json.Marshal(journal)
	if err != nil || len(data) > macUpgradeJournalLimit {
		return errors.New("macOS upgrade journal is invalid")
	}
	path := macUpgradeJournalPath(p)
	if err := fsx.WriteAtomic(path, data, 0o600, fsx.Current()); err != nil {
		return errors.New("macOS upgrade journal could not be written")
	}
	proof, err := fsx.ReadRegular(path, 0o600, fsx.Current())
	if err != nil || !bytes.Equal(data, proof) {
		return errors.New("macOS upgrade journal did not read back")
	}
	return nil
}

func moveMacUpgradePhase(p layout.MacRuntimePaths, journal *macUpgradeJournal, phase string) error {
	next := *journal
	next.Phase = phase
	if phase == "applying" {
		next.ServicesMayHaveChanged = true
	}
	if err := writeMacUpgradeJournal(p, &next); err != nil {
		return err
	}
	*journal = next
	return nil
}

func validMacUpgradeDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && hex.EncodeToString(decoded) == value
}

func macUpgradeTargets(home string, p layout.MacRuntimePaths, request macUpgradeRequest, deps macUpgradeDeps) ([]macUpgradeSnapshot, error) {
	if request.Pin != p.InstallDir || request.NodeBin != p.NodeBin || !validMacUpgradeDigest(request.SHA256) ||
		request.Version == "" || len(request.Version) > 128 || len(request.Keys) > 256 || len(request.Jobs) > 257 {
		return nil, errors.New("macOS recovery request is invalid")
	}
	keys := make(map[layout.ConnectorInstance]bool)
	for _, key := range request.Keys {
		if _, err := layout.ParseConnectorInstance(string(key.Instance)); err != nil || keys[key.Instance] {
			return nil, errors.New("macOS recovery key selector is invalid")
		}
		public, err := hex.DecodeString(key.Public)
		if err != nil || len(public) != 32 {
			return nil, errors.New("macOS recovery public identity is invalid")
		}
		keys[key.Instance] = true
	}
	result := []macUpgradeSnapshot{{Path: p.ExecutablePath, Mode: 0o700}, {Path: p.ToolConfig, Mode: 0o600},
		{Path: p.Probe, Mode: 0o600}, {Path: p.OAuthProbe, Mode: 0o600}}
	seen := make(map[string]bool)
	for _, job := range request.Jobs {
		service, err := checkedMacUpgradeService(home, deps, job.Kind, job.Instance)
		if err != nil || job.PID <= 0 || seen[serviceKey(job)] || job.Kind == launchd.Connector && !keys[job.Instance] {
			return nil, errors.New("macOS recovery job selector is invalid")
		}
		seen[serviceKey(job)] = true
		result = append(result, macUpgradeSnapshot{Path: service.PlistPath(), Mode: 0o600})
	}
	return result, nil
}

func serviceKey(job macUpgradeJob) string { return string(job.Kind) + ":" + string(job.Instance) }

func readMacUpgradePrivate(path string, mode fs.FileMode, limit int64) ([]byte, error) {
	info, err := fsx.Lstat(path)
	if err != nil || !info.Exists || info.Size > limit {
		return nil, errors.New("macOS recovery file is missing or too large")
	}
	return fsx.ReadRegular(path, mode, fsx.Current())
}

func validateMacUpgradeDescriptions(descriptions []macUpgradeBackup, targets []macUpgradeSnapshot) error {
	if len(descriptions) != len(targets) || len(descriptions) == 0 || !descriptions[0].Present {
		return errors.New("macOS recovery snapshot inventory is invalid")
	}
	for i, description := range descriptions {
		if description.Mode != targets[i].Mode || description.Present && !validMacUpgradeDigest(description.SHA256) ||
			!description.Present && description.SHA256 != "" {
			return errors.New("macOS recovery snapshot metadata is invalid")
		}
	}
	return nil
}

func readMacUpgradeCurrent(targets []macUpgradeSnapshot) ([]macUpgradeSnapshot, error) {
	result := make([]macUpgradeSnapshot, len(targets))
	for i := range result {
		result[i] = macUpgradeSnapshot{Path: targets[i].Path, Mode: targets[i].Mode}
		if err := result[i].read(); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func inspectMacUpgradeRecoveryDirectory(p layout.MacRuntimePaths) error {
	info, err := fsx.Lstat(filepath.Join(p.AppRoot, "upgrade-recovery"))
	if err != nil || info.Exists && (!info.Dir || info.Symlink || info.Mode != 0o700 || info.Owner != fsx.Current()) {
		return errors.New("macOS recovery directory is not private and user-owned")
	}
	return nil
}

func requireMacUpgradeFiles(targets []macUpgradeSnapshot, descriptions []macUpgradeBackup) error {
	current, err := readMacUpgradeCurrent(targets)
	if err != nil {
		return err
	}
	defer func() {
		for _, snapshot := range current {
			clear(snapshot.Data)
		}
	}()
	got := backupDescription(current)
	for i := range got {
		if got[i] != descriptions[i] {
			return errors.New("macOS recovery installed files changed; recovery was preserved")
		}
	}
	return nil
}

func loadMacUpgradeBackups(dir string, targets []macUpgradeSnapshot, journal *macUpgradeJournal) ([]macUpgradeSnapshot, error) {
	data, err := readMacUpgradePrivate(filepath.Join(dir, "index.json"), 0o600, macUpgradeJournalLimit)
	if err != nil {
		return nil, err
	}
	var index []macUpgradeSnapshot
	if decodeMacUpgradeJSON(data, &index) != nil || len(index) != len(targets) {
		return nil, errors.New("macOS recovery backup index is invalid")
	}
	requestData, err := readMacUpgradePrivate(filepath.Join(dir, "request.json"), 0o600, 64<<10)
	expected, marshalErr := json.Marshal(journal.Request)
	if err != nil || marshalErr != nil || !bytes.Equal(requestData, expected) {
		return nil, errors.New("macOS recovery handoff differs from its journal")
	}
	result := append([]macUpgradeSnapshot(nil), targets...)
	for i := range result {
		description := journal.Snapshots[i]
		if index[i].Path != targets[i].Path || index[i].Mode != description.Mode || index[i].Present != description.Present {
			return nil, errors.New("macOS recovery backup target is outside the recorded inventory")
		}
		result[i].Present = description.Present
		if description.Present {
			limit := int64(1 << 20)
			if result[i].Mode == 0o700 {
				limit = selfupdate.MaxBinarySize
			}
			result[i].Data, err = readMacUpgradePrivate(filepath.Join(dir, macUpgradeBackupName(i)), description.Mode, limit)
			if err != nil || selfupdate.Digest(result[i].Data) != description.SHA256 {
				return nil, errors.New("macOS recovery backup digest is invalid")
			}
		}
	}
	return result, nil
}

func cleanupMacUpgrade(p layout.MacRuntimePaths, deps macUpgradeDeps) error {
	dir := filepath.Join(p.AppRoot, "upgrade-recovery")
	// The terminal journal remains present throughout partial directory cleanup.
	first := filepath.Join(dir, macUpgradeBackupName(0))
	if info, err := fsx.Lstat(first); err != nil {
		return errors.New("macOS recovery cleanup could not inspect its backup")
	} else if info.Exists {
		if _, err := fsx.RequireRegular(first, 0o700, fsx.Current()); err != nil || os.Remove(first) != nil {
			return errors.New("macOS recovery cleanup could not remove its backup")
		}
	}
	macUpgradeCheckpoint(deps, "cleanup_partial")
	if err := os.RemoveAll(dir); err != nil {
		return errors.New("macOS recovery directory cleanup failed")
	}
	if err := removePrivateUnlinkFile(macUpgradeJournalPath(p), fsx.Current()); err != nil {
		return errors.New("macOS recovery journal cleanup failed")
	}
	return nil
}

// Called under the common setup lock, before any candidate download or mutation.
// Atomic file writes cover process interruption; no power-loss guarantee is asserted.
func recoverMacUpgrade(ctx context.Context, home string, p layout.MacRuntimePaths, deps macUpgradeDeps) (bool, error) {
	path := macUpgradeJournalPath(p)
	info, err := fsx.Lstat(path)
	if err != nil {
		return false, errors.New("macOS upgrade journal could not be inspected")
	}
	if !info.Exists {
		legacy, err := fsx.Lstat(filepath.Join(p.AppRoot, "upgrade-recovery"))
		if err != nil || legacy.Exists {
			return false, errors.New("legacy macOS recovery directory has no recognized journal; preserve it for inspection")
		}
		return false, nil
	}
	if err := inspectMacUpgradePaths(home, p); err != nil {
		return false, err
	}
	data, err := readMacUpgradePrivate(path, 0o600, macUpgradeJournalLimit)
	if err != nil {
		return false, err
	}
	var journal macUpgradeJournal
	if decodeMacUpgradeJSON(data, &journal) != nil || journal.Schema != 1 || len(journal.ID) != 32 ||
		journal.OldVersion == "" || len(journal.OldVersion) > 128 {
		return false, errors.New("macOS upgrade journal format is invalid")
	}
	if id, err := hex.DecodeString(journal.ID); err != nil || len(id) != 16 {
		return false, errors.New("macOS upgrade journal identity is invalid")
	}
	targets, err := macUpgradeTargets(home, p, journal.Request, deps)
	if err != nil {
		return false, err
	}
	if err := validateMacUpgradeDescriptions(journal.Snapshots, targets); err != nil {
		return false, err
	}
	dir := filepath.Join(p.AppRoot, "upgrade-recovery")
	if err := inspectMacUpgradeRecoveryDirectory(p); err != nil {
		return false, err
	}
	switch journal.Phase {
	case "committed", "rolled_back":
		want := journal.Snapshots
		if journal.Phase == "committed" {
			want = journal.Terminal
		}
		if err := validateMacUpgradeDescriptions(want, targets); err != nil {
			return false, err
		}
		if journal.Phase == "committed" && want[0].SHA256 != journal.Request.SHA256 {
			return false, errors.New("macOS committed binary differs from its candidate journal")
		}
		if err := requireMacUpgradeFiles(targets, want); err != nil {
			return false, err
		}
		if err := requireMacUpgradeKeys(ctx, journal.Request.Keys, deps); err != nil {
			return false, err
		}
	case "preparing", "prepared":
		if journal.ServicesMayHaveChanged {
			return false, errors.New("macOS preparation journal is inconsistent")
		}
		if err := requireMacUpgradeFiles(targets, journal.Snapshots); err != nil {
			return false, err
		}
		if err := requireMacUpgradeKeys(ctx, journal.Request.Keys, deps); err != nil {
			return false, err
		}
		if err := moveMacUpgradePhase(p, &journal, "rolled_back"); err != nil {
			return false, err
		}
	case "installing", "applying", "rolling_back":
		if journal.Phase == "installing" && journal.ServicesMayHaveChanged || journal.Phase == "applying" && !journal.ServicesMayHaveChanged {
			return false, errors.New("macOS upgrade mutation journal is inconsistent")
		}
		snapshots, err := loadMacUpgradeBackups(dir, targets, &journal)
		if err != nil {
			return false, err
		}
		defer func() {
			for _, snapshot := range snapshots {
				clear(snapshot.Data)
			}
		}()
		if err := moveMacUpgradePhase(p, &journal, "rolling_back"); err != nil {
			return false, err
		}
		previous := deps
		previous.Version = journal.OldVersion
		if err := restoreMacUpgrade(ctx, home, p, snapshots, journal.Request, previous, journal.ServicesMayHaveChanged); err != nil {
			return false, errors.New("macOS interrupted upgrade rollback was not fully proved; recovery was preserved")
		}
		if err := requireMacUpgradeFiles(targets, journal.Snapshots); err != nil {
			return false, err
		}
		if err := moveMacUpgradePhase(p, &journal, "rolled_back"); err != nil {
			return false, err
		}
	default:
		return false, errors.New("macOS upgrade journal phase is invalid")
	}
	if err := cleanupMacUpgrade(p, deps); err != nil {
		return false, err
	}
	return true, nil
}
