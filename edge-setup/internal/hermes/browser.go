package hermes

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"golang.org/x/sys/unix"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const chromiumRoot = "/usr/local/lib/hermes-chromium"
const chromiumMaxArchive int64 = 512 << 20
const chromiumMaxExpanded uint64 = 2 << 30
const chromiumMaxFiles = 20_000

type ChromiumAsset struct {
	Executable    string `json:"executable"`
	Version       string `json:"version"`
	ArchiveSHA256 string `json:"archiveSha256"`
	Target        string `json:"target"`
}

// EnsureLabChromium installs only compile-time pinned bytes. The guarded CLI
// owns authorization/profile configuration. This privileged provisioner runs
// no runtime code, plugin, package manager or browser executable.
func EnsureLabChromium(ctx context.Context) (ChromiumAsset, error) {
	pin, err := pins.ChromiumFor(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return ChromiumAsset{}, err
	}
	if os.Geteuid() != 0 {
		return ChromiumAsset{}, errors.New("managed Chromium provisioning requires root")
	}
	for _, parent := range []string{"/", "/usr", "/usr/local", "/usr/local/lib"} {
		if err := chromiumDirectory(parent, fsx.Root); err != nil {
			return ChromiumAsset{}, err
		}
	}
	if err := os.Mkdir(chromiumRoot, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return ChromiumAsset{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	client := download.Client{HTTP: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" || len(via) > 8 {
			return errors.New("unsafe Chromium download redirect")
		}
		return nil
	}}, Retries: 2, Backoff: 2 * time.Second, MaxBytes: chromiumMaxArchive}
	return installChromium(ctx, pin, chromiumRoot, fsx.Root, client.Fetch)
}

type chromiumFetch func(context.Context, string, string, download.Algorithm, string, fs.FileMode, fsx.Owner) error

func chromiumDirectory(name string, owner fsx.Owner) error {
	st, err := fsx.Lstat(name)
	if err != nil {
		return err
	}
	if !st.Exists || !st.Dir || st.Symlink || st.Owner != owner || st.Mode&0o022 != 0 {
		return fmt.Errorf("chromium directory is not owned and protected: %s", name)
	}
	return nil
}
func chromiumFile(name string, mode fs.FileMode, owner fsx.Owner) (*os.File, error) {
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || uint32(st.Mode)&0o7777 != uint32(mode) || int(st.Uid) != owner.UID || int(st.Gid) != owner.GID {
		file.Close()
		return nil, fmt.Errorf("chromium file is not an owned regular file: %s", name)
	}
	return file, nil
}

type chromiumReader struct {
	context.Context
	io.Reader
}

func (r chromiumReader) Read(b []byte) (int, error) {
	if err := r.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(b)
}
func chromiumDigest(ctx context.Context, source io.Reader) (string, error) {
	hash := sha256.New()
	_, err := io.Copy(hash, chromiumReader{ctx, source})
	return hex.EncodeToString(hash.Sum(nil)), err
}
func chromiumLock(ctx context.Context, root string, owner fsx.Owner) (func(), error) {
	fd, err := unix.Open(filepath.Join(root, ".install.lock"), unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Mode&0o7777 != 0o600 || int(st.Uid) != owner.UID || int(st.Gid) != owner.GID {
		unix.Close(fd)
		return nil, errors.New("unsafe Chromium install lock")
	}
	for {
		err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { _ = unix.Flock(fd, unix.LOCK_UN); _ = unix.Close(fd) }, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			unix.Close(fd)
			return nil, err
		}
		select {
		case <-ctx.Done():
			unix.Close(fd)
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func installChromium(ctx context.Context, pin pins.ChromiumArchive, root string, owner fsx.Owner, fetch chromiumFetch) (ChromiumAsset, error) {
	var result ChromiumAsset
	if err := chromiumDirectory(root, owner); err != nil {
		return result, err
	}
	unlock, err := chromiumLock(ctx, root, owner)
	if err != nil {
		return result, err
	}
	defer unlock()
	archive := filepath.Join(root, pin.Target+"-"+pin.SHA256+".zip")
	if err := fetch(ctx, pin.URL, archive, download.SHA256, pin.SHA256, 0o600, owner); err != nil {
		return result, err
	}
	file, err := chromiumFile(archive, 0o600, owner)
	if err != nil {
		return result, err
	}
	defer file.Close()
	st, err := file.Stat()
	if err != nil {
		return result, err
	}
	if st.Size() > chromiumMaxArchive {
		return result, errors.New("chromium archive size bound exceeded")
	}
	digest, err := chromiumDigest(ctx, file)
	if err != nil {
		return result, err
	}
	if digest != pin.SHA256 {
		return result, download.ErrChecksum
	}
	reader, err := zip.NewReader(file, st.Size())
	if err != nil {
		return result, err
	}
	files, dirs, executable, err := chromiumEntries(ctx, reader)
	if err != nil {
		return result, err
	}
	destination := filepath.Join(root, pin.Target+"-"+pin.SHA256)
	existing, err := fsx.Lstat(destination)
	if err != nil {
		return result, err
	}
	if !existing.Exists {
		stage, err := os.MkdirTemp(root, ".chromium-stage-")
		if err != nil {
			return result, err
		}
		defer os.RemoveAll(stage)
		if err := extractChromium(ctx, stage, files, dirs); err != nil {
			return result, err
		}
		if err := verifyChromium(ctx, stage, files, dirs, owner, true); err != nil {
			return result, err
		}
		if err := os.Chmod(stage, 0o755); err != nil {
			return result, err
		}
		if err := os.Rename(stage, destination); err != nil {
			return result, err
		}
		parent, err := os.Open(root)
		if err != nil {
			return result, err
		}
		err = parent.Sync()
		parent.Close()
		if err != nil {
			return result, err
		}
	}
	if err := verifyChromium(ctx, destination, files, dirs, owner, false); err != nil {
		return result, fmt.Errorf("chromium verification failed; retained for explicit repair: %w", err)
	}
	return ChromiumAsset{filepath.Join(destination, filepath.FromSlash(executable)), pins.ChromiumVersion, pin.SHA256, pin.Target}, nil
}
func chromiumEntries(ctx context.Context, reader *zip.Reader) (map[string]*zip.File, map[string]bool, string, error) {
	files := map[string]*zip.File{}
	dirs := map[string]bool{".": true}
	seen := map[string]bool{}
	executable := ""
	var total uint64
	if len(reader.File) > chromiumMaxFiles {
		return nil, nil, "", errors.New("too many Chromium ZIP entries")
	}
	for _, file := range reader.File {
		if err := ctx.Err(); err != nil {
			return nil, nil, "", err
		}
		name := strings.TrimSuffix(file.Name, "/")
		mode := file.Mode()
		if name == "" || name == "." || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) || strings.ContainsAny(name, "\\:\x00") || seen[name] || (!mode.IsRegular() && !mode.IsDir()) {
			return nil, nil, "", errors.New("unsafe, duplicate or special Chromium ZIP entry")
		}
		seen[name] = true
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			dirs[parent] = true
		}
		if mode.IsDir() {
			dirs[name] = true
			continue
		}
		if file.UncompressedSize64 > uint64(chromiumMaxArchive) || total > chromiumMaxExpanded-file.UncompressedSize64 {
			return nil, nil, "", errors.New("chromium ZIP expansion bound exceeded")
		}
		total += file.UncompressedSize64
		files[name] = file
		if (path.Base(name) == "chrome" || path.Base(name) == "chromium") && mode.Perm()&0o111 != 0 {
			if executable != "" {
				return nil, nil, "", errors.New("ambiguous Chromium executable")
			}
			executable = name
		}
	}
	for name := range dirs {
		if files[name] != nil {
			return nil, nil, "", errors.New("chromium ZIP file/directory collision")
		}
	}
	if executable == "" {
		return nil, nil, "", errors.New("no Chromium executable")
	}
	source, err := files[executable].Open()
	if err != nil {
		return nil, nil, "", err
	}
	var magic [4]byte
	_, err = io.ReadFull(source, magic[:])
	source.Close()
	if err != nil || string(magic[:]) != "\x7fELF" {
		return nil, nil, "", errors.New("chromium executable is not ELF")
	}
	return files, dirs, executable, nil
}
func chromiumMode(file *zip.File) fs.FileMode {
	if file.Mode().Perm()&0o111 != 0 {
		return 0o755
	}
	return 0o644
}
func extractChromium(ctx context.Context, stage string, files map[string]*zip.File, dirs map[string]bool) error {
	for name := range dirs {
		if name != "." {
			if err := os.MkdirAll(filepath.Join(stage, filepath.FromSlash(name)), 0o755); err != nil {
				return err
			}
		}
	}
	for name, entry := range files {
		source, err := entry.Open()
		if err != nil {
			return err
		}
		target, err := os.OpenFile(filepath.Join(stage, filepath.FromSlash(name)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, chromiumMode(entry))
		if err != nil {
			source.Close()
			return err
		}
		count, copyErr := io.Copy(target, io.LimitReader(chromiumReader{ctx, source}, int64(entry.UncompressedSize64)+1))
		closeSource := source.Close()
		syncErr := target.Sync()
		closeTarget := target.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeSource != nil {
			return closeSource
		}
		if syncErr != nil {
			return syncErr
		}
		if closeTarget != nil {
			return closeTarget
		}
		if count != int64(entry.UncompressedSize64) {
			return errors.New("chromium ZIP size mismatch")
		}
	}
	return nil
}
func verifyChromium(ctx context.Context, root string, files map[string]*zip.File, dirs map[string]bool, owner fsx.Owner, stage bool) error {
	if err := chromiumDirectory(root, owner); err != nil {
		return err
	}
	visitedFiles := 0
	visitedDirs := 0
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if !dirs[relative] {
				return errors.New("unexpected Chromium directory")
			}
			visitedDirs++
			if err := chromiumDirectory(name, owner); err != nil {
				return err
			}
			if relative != "." || !stage {
				st, err := fsx.Lstat(name)
				if err != nil {
					return err
				}
				if st.Mode != 0o755 {
					return errors.New("unexpected Chromium directory mode")
				}
			}
			return nil
		}
		archived := files[relative]
		if archived == nil {
			return errors.New("unexpected Chromium file")
		}
		visitedFiles++
		file, err := chromiumFile(name, chromiumMode(archived), owner)
		if err != nil {
			return err
		}
		defer file.Close()
		st, err := file.Stat()
		if err != nil {
			return err
		}
		if st.Size() != int64(archived.UncompressedSize64) {
			return errors.New("chromium installed file size changed")
		}
		got, err := chromiumDigest(ctx, file)
		if err != nil {
			return err
		}
		source, err := archived.Open()
		if err != nil {
			return err
		}
		want, digestErr := chromiumDigest(ctx, source)
		closeErr := source.Close()
		if digestErr != nil {
			return digestErr
		}
		if closeErr != nil {
			return closeErr
		}
		if got != want {
			return errors.New("chromium installed file digest changed")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if visitedFiles != len(files) || visitedDirs != len(dirs) {
		return errors.New("chromium installation is missing pinned files or directories")
	}
	return nil
}
