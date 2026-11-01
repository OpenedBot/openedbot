package hermes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestEnvStoreSnapshotsUseExplicitRootAndValidateProfile(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	writeStoreFile(t, filepath.Join(rootA, ".env"), "ROOT_VALUE=from-a\n", fsx.Current())
	writeStoreFile(t, filepath.Join(rootB, ".env"), "ROOT_VALUE=from-b\n", fsx.Current())
	profileA := filepath.Join(rootA, "profiles", "scout")
	profileB := filepath.Join(rootB, "profiles", "scout")
	if err := os.MkdirAll(profileA, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(profileB, 0o700); err != nil {
		t.Fatal(err)
	}
	writeStoreFile(t, filepath.Join(profileA, ".env"), "PROFILE_VALUE=from-a\n", fsx.Current())
	writeStoreFile(t, filepath.Join(profileB, ".env"), "PROFILE_VALUE=from-b\n", fsx.Current())

	storeA := EnvStore{Root: rootA, Owner: fsx.Current()}
	storeB := EnvStore{Root: rootB, Owner: fsx.Current()}
	gotRootA, err := storeA.SnapshotRootEnv()
	if err != nil || gotRootA["ROOT_VALUE"] != "from-a" {
		t.Fatalf("root A snapshot failed: err=%v", err)
	}
	gotProfileB, err := storeB.SnapshotProfileEnv("scout")
	if err != nil || gotProfileB["PROFILE_VALUE"] != "from-b" {
		t.Fatalf("root B profile snapshot failed: err=%v", err)
	}
	for _, invalid := range []string{"", "default", "../outside", "Upper", strings.Repeat("a", 64)} {
		if _, err := storeA.SnapshotProfileEnv(invalid); err == nil {
			t.Fatalf("invalid profile slug %q was accepted", invalid)
		}
	}
}

func TestEnvStoreMirrorIsRootScopedPreservesOwnedAndDeletesInheritedKeys(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	profileA := filepath.Join(rootA, "profiles", "scout")
	profileB := filepath.Join(rootB, "profiles", "scout")
	if err := os.MkdirAll(profileA, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(profileB, 0o700); err != nil {
		t.Fatal(err)
	}
	pathA := filepath.Join(profileA, ".env")
	pathB := filepath.Join(profileB, ".env")
	writeStoreFile(t, pathA, "OWNED=profile-value\nINHERITED=old\nREMOVED=old\nAPI_SERVER_KEY=profile-token\n", fsx.Current())
	writeStoreFile(t, filepath.Join(profileA, profileOwnFile), "# "+ProfileOwnMarker+"\nOWNED\n", fsx.Current())
	writeStoreFile(t, pathB, "INHERITED=other-root\nREMOVED=other-root\n", fsx.Current())

	before := map[string]string{"OWNED": "old-root", "INHERITED": "old", "REMOVED": "old", "API_SERVER_KEY": "root-token"}
	after := map[string]string{"OWNED": "new-root", "INHERITED": "new", "API_SERVER_KEY": "rotated-root-token"}
	store := EnvStore{Root: rootA, Owner: fsx.Current()}
	if err := store.MirrorRuntimeEnvDelta(before, after); err != nil {
		t.Fatal(err)
	}
	gotA, err := os.ReadFile(pathA)
	if err != nil {
		t.Fatal(err)
	}
	contentA := string(gotA)
	for _, want := range []string{"OWNED=profile-value\n", "INHERITED=new\n", "API_SERVER_KEY=profile-token\n"} {
		if !strings.Contains(contentA, want) {
			t.Fatalf("root A profile lost expected value %q", want)
		}
	}
	if strings.Contains(contentA, "REMOVED=") {
		t.Fatal("a deleted root key remained in the profile")
	}
	gotB, err := os.ReadFile(pathB)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotB) != "INHERITED=other-root\nREMOVED=other-root\n" {
		t.Fatal("a different EnvStore root was modified")
	}
	assertStoreFile(t, pathA, fsx.Current())
}

func TestEnvStorePreserveOwnProfileKeysWritesOwnedPrivateMarker(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "profiles", "operator")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeStoreFile(t, filepath.Join(profileDir, ".env"), "NEW_KEY=profile-value\n", fsx.Current())
	store := EnvStore{Root: root, Owner: fsx.Current()}
	before := map[string]string{"OLD_KEY": "present", "NEW_KEY": "old"}
	after := map[string]string{"NEW_KEY": "profile-value"}
	if err := store.PreserveOwnProfileKeys("operator", before, after); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(profileDir, profileOwnFile)
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "# "+ProfileOwnMarker+"\nNEW_KEY\n" {
		t.Fatal("marker did not contain only the changed, present key")
	}
	assertStoreFile(t, marker, fsx.Current())
}

func TestEnvStoreRefusesSymlinkAndIncorrectFilePermissions(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.env")
	if err := os.WriteFile(outside, []byte("KEY=outside\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(profileDir, ".env")); err != nil {
		t.Fatal(err)
	}
	store := EnvStore{Root: root, Owner: fsx.Current()}
	if _, err := store.SnapshotProfileEnv("scout"); err == nil {
		t.Fatal("profile env symlink was accepted")
	}
	if err := store.MirrorRuntimeEnvDelta(map[string]string{"KEY": "old"}, map[string]string{"KEY": "new"}); err == nil {
		t.Fatal("profile env symlink was overwritten")
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "KEY=outside\n" {
		t.Fatal("outside symlink target was changed")
	}
	if err := os.Remove(filepath.Join(profileDir, ".env")); err != nil {
		t.Fatal(err)
	}
	writeStoreFile(t, filepath.Join(profileDir, ".env"), "KEY=value\n", fsx.Current())
	if err := os.Chmod(filepath.Join(profileDir, ".env"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SnapshotProfileEnv("scout"); err == nil {
		t.Fatal("profile env with broad permissions was accepted")
	}
}

func TestEnvStoreRefusesSymlinkedMarkerAndWrongConfiguredOwner(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeStoreFile(t, filepath.Join(profileDir, ".env"), "KEY=value\n", fsx.Current())
	markerTarget := filepath.Join(t.TempDir(), "marker")
	if err := os.WriteFile(markerTarget, []byte("KEY\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(markerTarget, filepath.Join(profileDir, profileOwnFile)); err != nil {
		t.Fatal(err)
	}
	store := EnvStore{Root: root, Owner: fsx.Current()}
	if err := store.MirrorRuntimeEnvDelta(map[string]string{"KEY": "old"}, map[string]string{"KEY": "new"}); err == nil {
		t.Fatal("ownership marker symlink was accepted")
	}
	if err := os.Remove(filepath.Join(profileDir, profileOwnFile)); err != nil {
		t.Fatal(err)
	}
	wrongOwner := fsx.Current()
	wrongOwner.UID++
	if _, err := (EnvStore{Root: root, Owner: wrongOwner}).SnapshotProfileEnv("scout"); err == nil {
		t.Fatal("file owned by another configured uid was accepted")
	}
}

// swapOnOpen plays the race these readers guard against, as a process running
// as the service user would: the nth time (counting from 1) fsx holds path
// open and is about to use it, the name is moved aside to path+".real" and
// replaced by a symlink to victim. The next file fsx opens after that gets the
// name back, so nothing is left to find once the root process has been fooled.
func swapOnOpen(t *testing.T, path, victim string, nth int) {
	t.Helper()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	seen, swapped := 0, false
	t.Cleanup(fsx.SetAfterOpen(func(p string) {
		switch {
		case p == path:
			if seen++; seen == nth {
				swapped = true
				must(os.Rename(path, path+".real"))
				must(os.Symlink(victim, path))
			}
		case swapped:
			swapped = false
			must(os.Remove(path))
			must(os.Rename(path+".real", path))
		}
	}))
}

func TestEnvStoreNeverReadsASymlinkSwappedInAfterTheCheck(t *testing.T) {
	root := t.TempDir()
	env := filepath.Join(root, "profiles", "scout", ".env")
	writeStoreFile(t, env, "PROFILE_VALUE=service\n", fsx.Current())
	rootOnly := filepath.Join(t.TempDir(), "root-only.env")
	if err := os.WriteFile(rootOnly, []byte("LEAK=root-only\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	swapOnOpen(t, env, rootOnly, 1)
	got, err := (EnvStore{Root: root, Owner: fsx.Current()}).SnapshotProfileEnv("scout")
	if err != nil {
		t.Fatal(err)
	}
	if got["PROFILE_VALUE"] != "service" || len(got) != 1 {
		t.Fatalf("snapshot %v: the file the name was swapped for was read", got)
	}
}

func writeStoreFile(t *testing.T, path, content string, owner fsx.Owner) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsx.WriteAtomic(path, []byte(content), 0o600, owner); err != nil {
		t.Fatal(err)
	}
}

func assertStoreFile(t *testing.T, path string, owner fsx.Owner) {
	t.Helper()
	if _, err := fsx.ReadRegular(path, 0o600, owner); err != nil {
		t.Fatalf("file did not retain private permissions and configured owner: %v", err)
	}
}
