// Package fsx is the only way the tool writes to the host filesystem:
// atomic replaces, explicit modes and owners, and refusal to overwrite
// anything that is not a regular file.
//
// A name that can be swapped for a symlink after it was checked is never used
// twice. EnsureDir, EnsureDirUnder, TightenFile, ReadRegular, ReadFile and
// CopyFile open the leaf with O_NOFOLLOW and act through that descriptor
// (fchmod, fchown, read). WriteAtomic opens its directory once the same way,
// creates the temporary file in it with openat and renames it with renameat
// on that descriptor, so a directory swapped for a symlink in the middle of
// the write cannot redirect the file. EnsureDirUnder also walks below its
// base one descriptor at a time and refuses a symlink at every level.
//
// The components above the leaf (above the directory, for WriteAtomic) are
// resolved by the kernel as usual, so all of these belong on paths whose
// parents an unprivileged account cannot rewrite. Remove still looks with
// Lstat and then acts by path, and Lstat, Exists and RequireRegular only
// report what they saw: they are checks, not guards, and a swap after them is
// not excluded.
package fsx

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// ErrNotRegular is returned when a path exists but is not a regular file
// (or is a symlink).
var ErrNotRegular = errors.New("not a regular file")

// Owner identifies the expected uid/gid of a file. Root is {0, 0}.
type Owner struct{ UID, GID int }

// Root is the root owner.
var Root = Owner{0, 0}

// Current is the owner of the running process (used by tests).
func Current() Owner { return Owner{os.Geteuid(), os.Getegid()} }

// ErrWorldWritable refuses a mode that lets any user write: nothing this tool
// creates is writable by everyone, whatever the caller asks for.
var ErrWorldWritable = errors.New("mode is writable by every user")

func refuseWorldWritable(path string, mode fs.FileMode) error {
	if mode.Perm()&0o002 != 0 {
		return fmt.Errorf("%s: %04o: %w", path, mode.Perm(), ErrWorldWritable)
	}
	return nil
}

// WriteAtomic writes data to path via a temporary sibling then rename, so a
// crash leaves either the old file or the new one. Mode and owner are set
// on the temporary file before the rename.
//
// The directory is opened once, without following a symlink, and the
// temporary file is created and renamed relative to that descriptor: a
// directory swapped for a symlink while the write is running cannot send the
// file anywhere else. A directory that is itself a symlink is refused, and so
// is a target that is a symlink, a directory or a special file.
func WriteAtomic(path string, data []byte, mode fs.FileMode, owner Owner) error {
	if path == "" {
		return errors.New("write: empty path")
	}
	if err := refuseWorldWritable(path, mode); err != nil {
		return fmt.Errorf("write %w", err)
	}
	path = filepath.Clean(path)
	dirPath, name := filepath.Dir(path), filepath.Base(path)
	if name == "." || name == ".." || name == string(filepath.Separator) {
		return fmt.Errorf("write %s: %w", path, ErrNotRegular)
	}
	dir, err := openDir(dirPath)
	if err != nil {
		if refusedLeaf(err) {
			return fmt.Errorf("write %s: %s is a symlink or not a directory", path, dirPath)
		}
		return fmt.Errorf("write %s: %w", path, err)
	}
	defer dir.Close()
	opened(dirPath)
	tmp, tmpName, err := createTemp(dir, dirPath, "."+name+".")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	cleanup := func() { _ = retry(func() error { return unix.Unlinkat(int(dir.Fd()), tmpName, 0) }) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: chmod: %w", path, err)
	}
	if err := chown(tmp, owner); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: chown: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: sync: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := refuseNonRegularTarget(dir, name, path); err != nil {
		cleanup()
		return err
	}
	if err := retry(func() error { return unix.Renameat(int(dir.Fd()), tmpName, int(dir.Fd()), name) }); err != nil {
		cleanup()
		return fmt.Errorf("write %s: rename: %w", path, err)
	}
	return nil
}

func chown(f *os.File, owner Owner) error {
	cur := Current()
	if owner == cur {
		return nil
	}
	return f.Chown(owner.UID, owner.GID)
}

// retry runs op again for as long as a signal interrupts it, which the os
// package does for the calls it wraps.
func retry(op func() error) error {
	for {
		if err := op(); !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

// createTemp creates a new empty file named prefix and a random number in dir,
// with O_EXCL and mode 0600, and returns it open for writing with its name
// inside dir. dirPath is only for File.Name and messages.
func createTemp(dir *os.File, dirPath, prefix string) (*os.File, string, error) {
	for try := 0; ; try++ {
		name := prefix + strconv.FormatUint(uint64(rand.Uint32()), 10)
		fd, err := unix.Openat(int(dir.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
		switch {
		case err == nil:
			return os.NewFile(uintptr(fd), filepath.Join(dirPath, name)), name, nil
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.EEXIST) && try < 10000:
			continue // the name is taken: draw another
		}
		return nil, "", &fs.PathError{Op: "open", Path: filepath.Join(dirPath, name), Err: err}
	}
}

// refuseNonRegularTarget refuses to replace a symlink, a directory or a
// special file. The target is looked at through dir, without following it.
func refuseNonRegularTarget(dir *os.File, name, path string) error {
	var st unix.Stat_t
	err := retry(func() error { return unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW) })
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("write %s: %w", path, ErrNotRegular)
	}
	return nil
}

// Both sets of flags refuse a symlink at the leaf instead of following it.
// dirFlags also refuses anything that is not a directory. fileFlags is for a
// file the caller then checks with fstat: O_NONBLOCK keeps a FIFO swapped in
// by an unprivileged account from blocking the open forever, and O_NOCTTY
// keeps a terminal from becoming ours.
const (
	dirFlags  = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	fileFlags = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_NOCTTY | unix.O_CLOEXEC
)

// fchown is (*os.File).Chown, replaced by tests that cannot chown.
var fchown = func(f *os.File, uid, gid int) error { return f.Chown(uid, gid) }

// afterOpen is nil outside tests. It runs once a directory or a file is open
// and before it is used (its mode or owner applied, its content read, a
// temporary file created in it): the window in which a racing process swaps
// the name for a symlink.
var afterOpen func(path string)

func opened(path string) {
	if afterOpen != nil {
		afterOpen(path)
	}
}

// SetAfterOpen installs fn as the hook that runs in that window and returns a
// function that puts the previous hook back. It is the seam the tests of the
// packages that read or write through fsx use to play the race
// deterministically; production code never calls it.
func SetAfterOpen(fn func(path string)) (restore func()) {
	prev := afterOpen
	afterOpen = fn
	return func() { afterOpen = prev }
}

// refusedLeaf reports what an O_NOFOLLOW open returns for a symlink (ELOOP,
// EMLINK on some BSDs) or, with O_DIRECTORY, for anything that is not a
// directory (ENOTDIR).
func refusedLeaf(err error) bool {
	return errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.EMLINK) || errors.Is(err, syscall.ENOTDIR)
}

// openDir opens the directory at path, refusing a symlink at the leaf. The
// path is cleaned first: a trailing slash makes the kernel follow the leaf
// whatever O_NOFOLLOW says. Clean turns "" into ".", which must not mean the
// working directory here.
func openDir(path string) (*os.File, error) {
	if path == "" {
		return nil, &fs.PathError{Op: "open", Path: path, Err: syscall.ENOENT}
	}
	return os.OpenFile(filepath.Clean(path), dirFlags, 0)
}

// openDirAt opens the directory name inside dir, refusing a symlink, and
// creates it with mode when it does not exist (created says so). path is the
// full name, for messages and for File.Name.
func openDirAt(dir *os.File, name, path string, mode fs.FileMode) (f *os.File, created bool, err error) {
	f, err = openAt(dir, name, path)
	if errors.Is(err, fs.ErrNotExist) {
		if err := unix.Mkdirat(int(dir.Fd()), name, uint32(mode.Perm())); err != nil {
			return nil, false, fmt.Errorf("mkdir %s: %w", path, err)
		}
		created = true
		f, err = openAt(dir, name, path)
	}
	if err != nil {
		if refusedLeaf(err) {
			return nil, false, fmt.Errorf("mkdir %s: exists and is not a directory", path)
		}
		return nil, false, fmt.Errorf("mkdir %s: %w", path, err)
	}
	return f, created, nil
}

// openAt is openat(2) on the single component name of dir, with dirFlags.
func openAt(dir *os.File, name, path string) (*os.File, error) {
	for {
		fd, err := unix.Openat(int(dir.Fd()), name, dirFlags, 0)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return nil, &fs.PathError{Op: "open", Path: path, Err: err}
		}
		return os.NewFile(uintptr(fd), path), nil
	}
}

// openRegular opens the regular file at path for reading and reports what
// fstat says about it. A symlink at the leaf is refused instead of followed,
// and so is anything else that is not a regular file: both come back as
// ErrNotRegular, a missing file as an error that matches fs.ErrNotExist. The
// caller reads from the descriptor and never resolves the name a second time.
// The path is cleaned first, for the reason openDir gives.
func openRegular(path string) (*os.File, Stat, error) {
	if path == "" {
		return nil, Stat{}, &fs.PathError{Op: "open", Path: path, Err: syscall.ENOENT}
	}
	path = filepath.Clean(path)
	f, err := os.OpenFile(path, fileFlags, 0)
	switch {
	case errors.Is(err, syscall.ELOOP), errors.Is(err, syscall.EMLINK), errors.Is(err, syscall.ENXIO), errors.Is(err, syscall.EOPNOTSUPP):
		// A symlink at the leaf, or a socket, which cannot be opened.
		return nil, Stat{}, fmt.Errorf("%s: %w", path, ErrNotRegular)
	case err != nil:
		return nil, Stat{}, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, Stat{}, err
	}
	st := statOf(fi)
	if !st.Regular {
		_ = f.Close()
		return nil, Stat{}, fmt.Errorf("%s: %w", path, ErrNotRegular)
	}
	opened(path)
	return f, st, nil
}

// EnsureDir creates path (and parents with the same mode) if absent, then
// enforces mode and owner on the leaf. The leaf is opened without following
// a symlink and changed through that descriptor, so a symlink swapped in
// after the check is never followed; the parents are resolved as usual.
func EnsureDir(path string, mode fs.FileMode, owner Owner) error {
	if path == "" {
		return errors.New("mkdir: empty path")
	}
	if err := refuseWorldWritable(path, mode); err != nil {
		return fmt.Errorf("mkdir %w", err)
	}
	path = filepath.Clean(path)
	f, err := openDir(path)
	if errors.Is(err, fs.ErrNotExist) {
		// Parents are created traversable (0755): a 0700 leaf owned by a
		// service user must not sit under a root-only parent.
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", path, err)
		}
		if err := os.Mkdir(path, mode); err != nil {
			return fmt.Errorf("mkdir %s: %w", path, err)
		}
		f, err = openDir(path)
	}
	if err != nil {
		if refusedLeaf(err) {
			return fmt.Errorf("mkdir %s: exists and is not a directory", path)
		}
		return fmt.Errorf("mkdir %s: %w", path, err)
	}
	defer f.Close()
	opened(path)
	if err := f.Chmod(mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	if owner != Current() {
		if err := fchown(f, owner.UID, owner.GID); err != nil {
			return fmt.Errorf("chown %s: %w", path, err)
		}
	}
	return nil
}

// EnsureDirUnder is EnsureDir for a tree that belongs to owner below base,
// typically its home: every component between base (which must exist) and
// path is handed to owner, created or not, so a parent created here never
// stays root-owned and blocks the owner from creating its siblings. Created
// parents are 0755; mode applies to the leaf. A symlink or non-directory
// component is refused, base included. Never use it for a tree root must
// keep: owner can rename anything below a directory it owns.
//
// The walk holds a descriptor on base and opens each component relative to
// the one before it, never through a symlink (O_NOFOLLOW), then changes the
// component through its own descriptor. A name swapped for a symlink while
// the walk is running therefore cannot send a later step, or a mode or owner
// change, outside the tree.
func EnsureDirUnder(base, path string, mode fs.FileMode, owner Owner) error {
	if err := refuseWorldWritable(path, mode); err != nil {
		return fmt.Errorf("mkdir %w", err)
	}
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("mkdir %s: not below %s", path, base)
	}
	dir, err := openDir(base)
	if err != nil {
		return fmt.Errorf("mkdir %s: %s is not a directory", path, base)
	}
	defer func() { dir.Close() }()
	parts := strings.Split(rel, string(filepath.Separator))
	cur := filepath.Clean(base)
	for k, part := range parts {
		cur = filepath.Join(cur, part)
		want := fs.FileMode(0o755)
		last := k == len(parts)-1
		if last {
			want = mode
		}
		next, created, err := openDirAt(dir, part, cur, want)
		if err != nil {
			return err
		}
		dir.Close()
		dir = next
		opened(cur)
		if created || last {
			if err := dir.Chmod(want); err != nil {
				return fmt.Errorf("chmod %s: %w", cur, err)
			}
		}
		st, err := dir.Stat()
		if err != nil {
			return fmt.Errorf("stat %s: %w", cur, err)
		}
		if ownerOf(st) != owner {
			if err := fchown(dir, owner.UID, owner.GID); err != nil {
				return fmt.Errorf("chown %s: %w", cur, err)
			}
		}
	}
	return nil
}

// TightenFile puts the regular file at path to mode and, when both ids of
// owner are set (not negative), to owner, and says through log (nil is fine)
// what it repaired: a mode nobody meant to change is repaired, not refused. A
// missing file is not an error. A symlink or anything else that is not a
// regular file is refused with ErrNotRegular and never followed: the file is
// opened with O_NOFOLLOW, checked with fstat and changed through that
// descriptor.
func TightenFile(path string, mode fs.FileMode, owner Owner, log func(string, ...any)) error {
	if path == "" {
		return errors.New("tighten: empty path")
	}
	if err := refuseWorldWritable(path, mode); err != nil {
		return fmt.Errorf("tighten %w", err)
	}
	path = filepath.Clean(path)
	f, st, err := openRegular(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return err
	}
	defer f.Close()
	if log == nil {
		log = func(string, ...any) {}
	}
	if st.Mode != mode.Perm() {
		if err := f.Chmod(mode); err != nil {
			return err
		}
		log("%s was mode %04o; set back to %04o", path, st.Mode, mode.Perm())
	}
	if owner.UID >= 0 && owner.GID >= 0 && st.Owner != owner {
		if err := fchown(f, owner.UID, owner.GID); err != nil {
			return err
		}
		log("%s was owned by %d:%d; given back to %d:%d", path, st.Owner.UID, st.Owner.GID, owner.UID, owner.GID)
	}
	return nil
}

// Stat describes a path without following symlinks.
type Stat struct {
	Exists  bool
	Regular bool
	Dir     bool
	Symlink bool
	Mode    fs.FileMode
	Owner   Owner
	Size    int64
}

// Lstat returns a Stat; a missing path is not an error.
func Lstat(path string) (Stat, error) {
	st, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Stat{}, nil
	}
	if err != nil {
		return Stat{}, err
	}
	return statOf(st), nil
}

func statOf(st fs.FileInfo) Stat {
	return Stat{
		Exists:  true,
		Regular: st.Mode().IsRegular(),
		Dir:     st.IsDir(),
		Symlink: st.Mode()&fs.ModeSymlink != 0,
		Mode:    st.Mode().Perm(),
		Owner:   ownerOf(st),
		Size:    st.Size(),
	}
}

func ownerOf(st fs.FileInfo) Owner {
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		return Owner{int(sys.Uid), int(sys.Gid)}
	}
	return Owner{}
}

// Exists reports whether path exists (symlinks included, not followed).
func Exists(path string) bool {
	s, err := Lstat(path)
	return err == nil && s.Exists
}

// RequireRegular refuses a path that exists but is not a regular file, and
// when mode is non-zero, a regular file whose permission bits or owner
// differ. A missing file returns (false, nil). It only reports what it saw: to
// read the file, use ReadRegular, which checks the very file it reads.
func RequireRegular(path string, mode fs.FileMode, owner Owner) (bool, error) {
	s, err := Lstat(path)
	if err != nil {
		return false, err
	}
	if !s.Exists {
		return false, nil
	}
	return true, checkRegular(path, s, mode, owner)
}

// checkRegular is what RequireRegular and ReadRegular demand of a file once
// they know what it is.
func checkRegular(path string, s Stat, mode fs.FileMode, owner Owner) error {
	if !s.Regular || s.Symlink {
		return fmt.Errorf("%s: %w", path, ErrNotRegular)
	}
	if mode != 0 && s.Mode != mode {
		return fmt.Errorf("%s: mode %04o, want %04o", path, s.Mode, mode)
	}
	if s.Owner != owner {
		return fmt.Errorf("%s: owner %d:%d, want %d:%d", path, s.Owner.UID, s.Owner.GID, owner.UID, owner.GID)
	}
	return nil
}

// ReadRegular reads the regular file at path that has the mode (when non-zero)
// and the owner RequireRegular demands. The file is opened without following a
// symlink, checked with fstat and read from that descriptor, so what is read
// is the file that was checked even if the name is swapped in between. A
// missing file is an error that matches fs.ErrNotExist.
func ReadRegular(path string, mode fs.FileMode, owner Owner) ([]byte, error) {
	f, st, err := openRegular(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%s: %w", path, fs.ErrNotExist)
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := checkRegular(path, st, mode, owner); err != nil {
		return nil, err
	}
	return readAll(f, st.Size)
}

// ReadFile reads the regular file at path, whatever its mode and owner. Like
// ReadRegular it opens the file without following a symlink and reads from that
// descriptor; a symlink or any other file that is not a regular file is
// refused with ErrNotRegular, and a missing file is an error that matches
// fs.ErrNotExist.
func ReadFile(path string) ([]byte, error) {
	f, st, err := openRegular(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readAll(f, st.Size)
}

// readAll reads f to EOF. hint is the size fstat reported: it only presizes
// the buffer, and is capped so that a lying size cannot make the allocation
// huge before a byte is read.
func readAll(f *os.File, hint int64) ([]byte, error) {
	var buf bytes.Buffer
	buf.Grow(int(min(max(hint, 0), 64<<20)) + bytes.MinRead)
	_, err := buf.ReadFrom(f)
	return buf.Bytes(), err
}

// Remove deletes a regular file or symlink; a missing path is fine. It
// refuses directories.
func Remove(path string) error {
	s, err := Lstat(path)
	if err != nil {
		return err
	}
	if !s.Exists {
		return nil
	}
	if s.Dir {
		return fmt.Errorf("remove %s: is a directory", path)
	}
	return os.Remove(path)
}

// CopyFile copies src to dst atomically with the given mode and owner,
// refusing a src that is missing or is not a regular file. src is opened
// without following a symlink and read from that descriptor, so a name swapped
// after the check is not what gets copied.
func CopyFile(src, dst string, mode fs.FileMode, owner Owner) error {
	f, st, err := openRegular(src)
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, ErrNotRegular):
		return fmt.Errorf("copy %s: %w", src, ErrNotRegular)
	case err != nil:
		return err
	}
	defer f.Close()
	data, err := readAll(f, st.Size)
	if err != nil {
		return err
	}
	return WriteAtomic(dst, data, mode, owner)
}
