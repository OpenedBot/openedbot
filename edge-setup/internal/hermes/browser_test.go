package hermes

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type browserZipEntry struct {
	name, body string
	mode       fs.FileMode
}

func browserZip(t *testing.T, entries ...browserZipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		header.SetMode(entry.mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func browserFixture(t *testing.T, data []byte) (string, pins.ChromiumArchive, chromiumFetch) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	pin := pins.ChromiumArchive{Target: "linux-x64", URL: "https://pinned.invalid/chromium.zip", SHA256: hex.EncodeToString(sum[:])}
	fetch := func(ctx context.Context, url, dest string, algorithm download.Algorithm, checksum string, mode fs.FileMode, owner fsx.Owner) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if url != pin.URL || algorithm != download.SHA256 || checksum != pin.SHA256 || mode != 0o600 || owner != fsx.Current() {
			return errors.New("unexpected download contract")
		}
		return fsx.WriteAtomic(dest, data, mode, owner)
	}
	return root, pin, fetch
}
func validBrowserZip(t *testing.T) []byte {
	return browserZip(t, browserZipEntry{"chrome-linux64/chrome", "\x7fELF-not-executed", 0o755}, browserZipEntry{"chrome-linux64/resources/data.pak", "pinned-resource", 0o644})
}
func installBrowserFixture(t *testing.T) (ChromiumAsset, string, pins.ChromiumArchive, chromiumFetch) {
	t.Helper()
	root, pin, fetch := browserFixture(t, validBrowserZip(t))
	asset, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch)
	if err != nil {
		t.Fatal(err)
	}
	return asset, root, pin, fetch
}
func TestPinnedChromiumInstallAndIdempotentReadback(t *testing.T) {
	asset, root, pin, fetch := installBrowserFixture(t)
	again, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch)
	if err != nil {
		t.Fatal(err)
	}
	if asset != again || asset.ArchiveSHA256 != pin.SHA256 || asset.Version != pins.ChromiumVersion || !strings.HasPrefix(asset.Executable, root+string(os.PathSeparator)) {
		t.Fatalf("unexpected evidence: %#v", asset)
	}
	st, err := os.Stat(asset.Executable)
	if err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("mode: %v %v", st, err)
	}
	if matches, _ := filepath.Glob(filepath.Join(root, ".chromium-stage-*")); len(matches) != 0 {
		t.Fatal("stage retained after success")
	}
}
func TestPinnedChromiumRejectsUnsafeArchives(t *testing.T) {
	cases := map[string][]browserZipEntry{
		"traversal": {{"../outside", "x", 0o644}}, "absolute": {{"/outside", "x", 0o644}}, "dot": {{"a/../outside", "x", 0o644}},
		"backslash": {{"a\\outside", "x", 0o644}}, "drive": {{"C:outside", "x", 0o644}}, "symlink": {{"link", "/outside", fs.ModeSymlink | 0o777}},
		"fifo": {{"pipe", "", fs.ModeNamedPipe | 0o600}}, "duplicate": {{"chrome", "\x7fELF", 0o755}, {"chrome", "\x7fELF", 0o755}},
		"collision": {{"a", "file", 0o644}, {"a/chrome", "\x7fELF", 0o755}}, "ambiguous": {{"a/chrome", "\x7fELF", 0o755}, {"b/chromium", "\x7fELF", 0o755}},
		"script": {{"chrome", "#!/bin/sh\nexit 0", 0o755}}, "missing browser": {{"resource", "x", 0o644}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			root, pin, fetch := browserFixture(t, browserZip(t, entries...))
			_, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch)
			if err == nil {
				t.Fatal("unsafe archive accepted")
			}
			if _, err := os.Stat(filepath.Join(root, pin.Target+"-"+pin.SHA256)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("unsafe archive promoted")
			}
		})
	}
}
func TestPinnedChromiumRefusesTamperedTreeWithoutRepairingOrExecuting(t *testing.T) {
	for _, change := range []string{"bytes", "missing", "extra", "mode", "symlink", "directory symlink", "directory mode"} {
		t.Run(change, func(t *testing.T) {
			asset, root, pin, fetch := installBrowserFixture(t)
			entryRoot := filepath.Join(root, pin.Target+"-"+pin.SHA256)
			switch change {
			case "bytes":
				if err := os.WriteFile(asset.Executable, []byte("\x7fELF-was-modified"), 0o755); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(asset.Executable); err != nil {
					t.Fatal(err)
				}
			case "extra":
				if err := os.WriteFile(filepath.Join(entryRoot, "foreign"), []byte("retain"), 0o644); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(asset.Executable, 0o777); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(asset.Executable); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("/bin/sh", asset.Executable); err != nil {
					t.Fatal(err)
				}
			case "directory symlink":
				dir := filepath.Join(entryRoot, "chrome-linux64/resources")
				if err := os.RemoveAll(dir); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(t.TempDir(), dir); err != nil {
					t.Fatal(err)
				}
			case "directory mode":
				if err := os.Chmod(filepath.Join(entryRoot, "chrome-linux64"), 0o777); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch); err == nil {
				t.Fatal("tampered install accepted")
			}
			if _, err := os.Lstat(entryRoot); err != nil {
				t.Fatal("unproven tree deleted instead of retained")
			}
		})
	}
}
func TestPinnedChromiumChecksDownloadedBytesIndependently(t *testing.T) {
	root, pin, fetch := browserFixture(t, validBrowserZip(t))
	bad := func(ctx context.Context, url, dest string, a download.Algorithm, sum string, mode fs.FileMode, owner fsx.Owner) error {
		if err := fetch(ctx, url, dest, a, sum, mode, owner); err != nil {
			return err
		}
		return os.WriteFile(dest, []byte("wrong archive"), 0o600)
	}
	if _, err := installChromium(context.Background(), pin, root, fsx.Current(), bad); !errors.Is(err, download.ErrChecksum) {
		t.Fatalf("wanted checksum refusal: %v", err)
	}
}
func TestPinnedChromiumRejectsUnsafeRootAndArchiveSymlink(t *testing.T) {
	root, pin, fetch := browserFixture(t, validBrowserZip(t))
	if err := os.Chmod(root, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch); err == nil {
		t.Fatal("writable root accepted")
	}
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, pin.Target+"-"+pin.SHA256+".zip")); err != nil {
		t.Fatal(err)
	}
	if _, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch); err == nil {
		t.Fatal("archive symlink accepted")
	}
	bytes, err := os.ReadFile(outside)
	if err != nil || string(bytes) != "retain" {
		t.Fatal("outside file changed")
	}
}
func TestPinnedChromiumCancellationAndInterruptedStageResume(t *testing.T) {
	root, pin, fetch := browserFixture(t, validBrowserZip(t))
	stale := filepath.Join(root, ".chromium-stage-previous")
	if err := os.Mkdir(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := installChromium(ctx, pin, root, fsx.Current(), fetch); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled operation: %v", err)
	}
	if _, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); err != nil {
		t.Fatal("unowned stale tree was adopted or removed")
	}
	unlock, err := chromiumLock(context.Background(), root, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	bounded, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, err := installChromium(bounded, pin, root, fsx.Current(), fetch); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait not bounded: %v", err)
	}
}
func TestPinnedChromiumExpansionBounds(t *testing.T) {
	data := validBrowserZip(t)
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	reader.File[0].UncompressedSize64 = uint64(chromiumMaxArchive) + 1
	if _, _, _, err := chromiumEntries(context.Background(), reader); err == nil {
		t.Fatal("oversized ZIP entry accepted")
	}
	reader.File = make([]*zip.File, chromiumMaxFiles+1)
	if _, _, _, err := chromiumEntries(context.Background(), reader); err == nil {
		t.Fatal("too many ZIP entries accepted")
	}
}

func TestPinnedChromiumNeverInstallsSetuidOrGroupWritableFiles(t *testing.T) {
	data := browserZip(t, browserZipEntry{"chrome", "\x7fELF-not-executed", fs.ModeSetuid | fs.ModeSetgid | 0o777})
	root, pin, fetch := browserFixture(t, data)
	asset, err := installChromium(context.Background(), pin, root, fsx.Current(), fetch)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(asset.Executable)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o755 || st.Mode()&(fs.ModeSetuid|fs.ModeSetgid) != 0 {
		t.Fatalf("privileged executable mode: %v", st.Mode())
	}
}
func TestPinnedChromiumDoesNotAdoptForeignOwner(t *testing.T) {
	root, pin, fetch := browserFixture(t, validBrowserZip(t))
	owner := fsx.Current()
	owner.UID++
	if _, err := installChromium(context.Background(), pin, root, owner, fetch); err == nil {
		t.Fatal("foreign-owned install root accepted")
	}
}
