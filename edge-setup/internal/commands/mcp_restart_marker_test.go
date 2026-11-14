package commands

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestMarkCLIGatewayRestartCreatesPrivateTimestampAndPreservesItOnReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart-pending")
	if err := markCLIGatewayRestart(path); err != nil {
		t.Fatal("could not create temporary gateway restart marker")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("new restart marker is not a private file")
	}
	state, err := fsx.Lstat(path)
	if err != nil || state.Owner != fsx.Current() {
		t.Fatal("new restart marker is not owned by the current user")
	}
	initial, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("new restart marker could not be read back")
	}
	if _, err := time.Parse(time.RFC3339, strings.TrimSpace(string(initial))); err != nil {
		t.Fatal("new restart marker does not contain an RFC3339 timestamp")
	}
	time.Sleep(1100 * time.Millisecond)
	if err := markCLIGatewayRestart(path); err != nil {
		t.Fatal("replaying the restart marker write failed")
	}
	final, err := os.ReadFile(path)
	if err != nil || string(final) != string(initial) {
		t.Fatal("replaying the restart marker write changed the first timestamp")
	}
	finalInfo, err := os.Stat(path)
	if err != nil || !os.SameFile(info, finalInfo) {
		t.Fatal("replaying the restart marker replaced the original marker file")
	}
}

func TestMarkCLIGatewayRestartConcurrentCallersLeaveOnePrivateMarkerAndNoTemps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "restart-pending")
	const callers = 8
	start := make(chan struct{})
	errs := make(chan error, callers)
	var workers sync.WaitGroup
	workers.Add(callers)
	for range callers {
		go func() {
			defer workers.Done()
			<-start
			errs <- markCLIGatewayRestart(path)
		}()
	}
	close(start)
	workers.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal("concurrent gateway restart marker call failed")
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("concurrent marker was not published")
	}
	if _, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data))); err != nil {
		t.Fatal("concurrent marker does not contain a valid timestamp")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("concurrent marker is not private")
	}
	state, err := fsx.Lstat(path)
	if err != nil || state.Owner != fsx.Current() {
		t.Fatal("concurrent marker is not owned by the current user")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "restart-pending" {
		t.Fatal("concurrent marker publication left temporary files behind")
	}
}

func TestMarkCLIGatewayRestartPreservesReadableLegacyMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart-pending")
	original := []byte("2026-09-20T10:11:12Z\n")
	if err := fsx.WriteAtomic(path, original, 0o644, fsx.Current()); err != nil {
		t.Fatal("could not create a current-user legacy marker fixture")
	}
	if err := markCLIGatewayRestart(path); err != nil {
		t.Fatal("valid current-user marker readable by others was refused")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != string(original) {
		t.Fatal("accepted legacy marker was rewritten")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatal("accepted legacy marker permissions were changed")
	}
}

func TestMarkCLIGatewayRestartRefusesSymlinkAndInvalidExistingMarker(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target")
		marker := filepath.Join(dir, "restart-pending")
		original := []byte("2026-09-20T10:11:12Z\n")
		if err := os.WriteFile(target, original, 0o600); err != nil {
			t.Fatal("could not create temporary marker target")
		}
		if err := os.Symlink(target, marker); err != nil {
			t.Fatal("could not create temporary marker symlink")
		}
		if err := markCLIGatewayRestart(marker); err == nil {
			t.Fatal("symlinked restart marker was accepted")
		}
		resolved, err := os.Readlink(marker)
		if err != nil || resolved != target {
			t.Fatal("refused marker symlink was changed")
		}
		data, err := os.ReadFile(target)
		if err != nil || string(data) != string(original) {
			t.Fatal("refusing the marker symlink changed its target")
		}
	})

	t.Run("invalid timestamp", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "restart-pending")
		original := []byte("not-an-RFC3339-timestamp\n")
		if err := fsx.WriteAtomic(path, original, 0o644, fsx.Current()); err != nil {
			t.Fatal("could not create invalid timestamp fixture")
		}
		if err := markCLIGatewayRestart(path); err == nil {
			t.Fatal("invalid existing restart timestamp was accepted")
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != string(original) {
			t.Fatal("invalid existing marker was changed after refusal")
		}
	})

	t.Run("group writable", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "restart-pending")
		original := []byte("2026-09-20T10:11:12Z\n")
		if err := fsx.WriteAtomic(path, original, 0o660, fsx.Current()); err != nil {
			t.Fatal("could not create group-writable marker fixture")
		}
		if err := markCLIGatewayRestart(path); err == nil {
			t.Fatal("group-writable existing restart marker was accepted")
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != string(original) {
			t.Fatal("refused group-writable marker was changed")
		}
	})
}

func TestMarkCLIGatewayRestartRejectsInvalidPathsWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	dirty := filepath.Join(dir, "sub") + string(os.PathSeparator) + ".." + string(os.PathSeparator) + "restart-pending"
	newline := filepath.Join(dir, "restart-pending") + "\ninvalid"
	for _, path := range []string{"", "relative-marker", dirty, newline} {
		if err := markCLIGatewayRestart(path); err == nil {
			t.Fatal("invalid restart marker path was accepted")
		}
	}
}
