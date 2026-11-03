package fsx

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWriteAtomicReplacesAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	if err := WriteAtomic(p, []byte("one\n"), 0o600, Current()); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(p, []byte("two\n"), 0o600, Current()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if string(got) != "two\n" {
		t.Fatalf("content %q", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary file left behind: %v", entries)
	}
	st, _ := Lstat(p)
	if st.Mode != 0o600 || !st.Regular {
		t.Fatalf("stat %+v", st)
	}
}

func TestWriteAtomicRefusesSymlinkTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	_ = os.WriteFile(target, []byte("x"), 0o600)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	err := WriteAtomic(link, []byte("y"), 0o600, Current())
	if !errors.Is(err, ErrNotRegular) {
		t.Fatalf("expected ErrNotRegular, got %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "x" {
		t.Fatal("the symlink target was overwritten")
	}
}

func TestWriteAtomicRefusesToReplaceWhatIsNotARegularFileAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	for name, setup := range map[string]func() error{
		"symlink":   func() error { return os.Symlink(filepath.Join(dir, "elsewhere"), target) },
		"directory": func() error { return os.Mkdir(target, 0o755) },
		"fifo":      func() error { return syscall.Mkfifo(target, 0o644) },
	} {
		if err := setup(); err != nil {
			t.Skipf("%s unavailable: %v", name, err)
		}
		if err := WriteAtomic(target, []byte("y"), 0o600, Current()); !errors.Is(err, ErrNotRegular) {
			t.Errorf("%s: %v, want ErrNotRegular", name, err)
		}
		if got := names(t, dir); len(got) != 1 {
			t.Errorf("%s: temporary file left behind: %v", name, got)
		}
		if err := os.Remove(target); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWriteAtomicRefusesADirectoryThatIsASymlink(t *testing.T) {
	behind, home := t.TempDir(), t.TempDir()
	link := filepath.Join(home, "link")
	if err := os.Symlink(behind, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := WriteAtomic(filepath.Join(link, "f"), []byte("y"), 0o600, Current()); err == nil {
		t.Fatal("a directory that is a symlink was accepted")
	}
	if got := names(t, behind); len(got) != 0 {
		t.Fatalf("the symlink was followed: %v", got)
	}
}

func TestWriteAtomicTakesARelativePathAndRefusesOnesThatNameNoFile(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := WriteAtomic("f", []byte("one\n"), 0o600, Current()); err != nil || readText(t, "f") != "one\n" {
		t.Fatalf("relative path: %v", err)
	}
	for _, p := range []string{"", ".", "..", "/", "sub/.."} {
		if err := WriteAtomic(p, []byte("x"), 0o600, Current()); err == nil {
			t.Errorf("%q was accepted", p)
		}
	}
	if got := names(t, "."); len(got) != 1 {
		t.Fatalf("unexpected files: %v", got)
	}
}

func TestRequireRegular(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "m")
	if exists, err := RequireRegular(p, 0o600, Current()); exists || err != nil {
		t.Fatalf("missing: exists=%v err=%v", exists, err)
	}
	_ = os.WriteFile(p, []byte("x"), 0o644)
	if _, err := RequireRegular(p, 0o600, Current()); err == nil || !strings.Contains(err.Error(), "mode") {
		t.Fatalf("wrong mode must be refused: %v", err)
	}
	if _, err := RequireRegular(p, 0o644, Current()); err != nil {
		t.Fatal(err)
	}
	if _, err := RequireRegular(dir, 0, Current()); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("directory must be refused: %v", err)
	}
}

func TestReadRegularAndReadFileKeepTheirContract(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "m")
	if _, err := ReadRegular(p, 0o600, Current()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a missing file must match fs.ErrNotExist: %v", err)
	}
	if _, err := ReadFile(p); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a missing file must match fs.ErrNotExist: %v", err)
	}
	if _, err := ReadRegular("", 0o600, Current()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("an empty path is a missing file: %v", err)
	}
	writeText(t, p, "")
	if got, err := ReadRegular(p, 0o600, Current()); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("an empty file reads as empty: %v %v", got, err)
	}
	writeText(t, p, strings.Repeat("0123456789", 100))
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRegular(p, 0o600, Current()); err == nil || !strings.Contains(err.Error(), "mode") {
		t.Fatalf("wrong mode must be refused: %v", err)
	}
	svc := Owner{Current().UID + 1, Current().GID + 1}
	if _, err := ReadRegular(p, 0o644, svc); err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("wrong owner must be refused: %v", err)
	}
	if got, err := ReadRegular(p, 0, Current()); err != nil || len(got) != 1000 {
		t.Fatalf("mode 0 accepts any mode: %d bytes, %v", len(got), err)
	}
	if got, err := ReadFile(p); err != nil || len(got) != 1000 {
		t.Fatalf("ReadFile: %d bytes, %v", len(got), err)
	}
}

func TestEnsureDirAndRemove(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a", "b")
	if err := EnsureDir(p, 0o700, Current()); err != nil {
		t.Fatal(err)
	}
	st, _ := Lstat(p)
	if !st.Dir || st.Mode != 0o700 {
		t.Fatalf("%+v", st)
	}
	// The parent must stay traversable: a service user's 0700 home under a
	// root-only parent is what broke the first container run.
	if parent, _ := Lstat(filepath.Join(dir, "a")); parent.Mode != 0o755 {
		t.Fatalf("parent mode %04o, want 0755", parent.Mode)
	}
	f := filepath.Join(p, "f")
	_ = os.WriteFile(f, nil, 0o600)
	if err := Remove(f); err != nil || Exists(f) {
		t.Fatalf("remove: %v exists=%v", err, Exists(f))
	}
	if err := Remove(f); err != nil {
		t.Fatalf("remove missing must be fine: %v", err)
	}
	if err := Remove(p); err == nil {
		t.Fatal("Remove must refuse directories")
	}
}

// recordChown replaces fchown for the test: an unprivileged run cannot hand
// a directory to another uid, so the owner is recorded instead.
func recordChown(t *testing.T) map[string]Owner {
	t.Helper()
	got := map[string]Owner{}
	prev := fchown
	fchown = func(f *os.File, uid, gid int) error {
		got[f.Name()] = Owner{uid, gid}
		return nil
	}
	t.Cleanup(func() { fchown = prev })
	return got
}

func TestEnsureDirUnderHandsCreatedParentsToTheOwner(t *testing.T) {
	home := t.TempDir()
	svc := Owner{Current().UID + 1, Current().GID + 1}
	chowned := recordChown(t)
	leaf := filepath.Join(home, ".config", "docker")
	if err := EnsureDirUnder(home, leaf, 0o750, svc); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(home, ".config"), leaf} {
		if chowned[p] != svc {
			t.Fatalf("%s owner %+v, want %+v (chowned: %v)", p, chowned[p], svc, chowned)
		}
	}
	if _, ok := chowned[home]; ok {
		t.Fatal("base must be left alone")
	}
	if st, _ := Lstat(filepath.Join(home, ".config")); st.Mode != 0o755 {
		t.Fatalf("parent mode %04o, want 0755", st.Mode)
	}
	if st, _ := Lstat(leaf); st.Mode != 0o750 {
		t.Fatalf("leaf mode %04o, want 0750", st.Mode)
	}
}

func TestEnsureDirUnderRepairsAnExistingForeignParent(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, ".config")
	if err := os.Mkdir(cfg, 0o700); err != nil {
		t.Fatal(err)
	}
	svc := Owner{Current().UID + 1, Current().GID + 1}
	chowned := recordChown(t)
	if err := EnsureDirUnder(home, filepath.Join(cfg, "docker"), 0o755, svc); err != nil {
		t.Fatal(err)
	}
	if chowned[cfg] != svc {
		t.Fatalf("a parent left by an earlier run as another owner must be handed over: %v", chowned)
	}
	if st, _ := Lstat(cfg); st.Mode != 0o700 {
		t.Fatalf("an existing parent keeps its mode, got %04o", st.Mode)
	}
}

func TestEnsureDirUnderRefusesEscapesAndSymlinks(t *testing.T) {
	home := t.TempDir()
	recordChown(t)
	if err := EnsureDirUnder(home, filepath.Join(home, "..", "x"), 0o755, Current()); err == nil {
		t.Fatal("a path outside base must be refused")
	}
	if err := EnsureDirUnder(home, home, 0o755, Current()); err == nil {
		t.Fatal("base itself is not below base")
	}
	// filepath.Clean turns "" into ".": neither may be read as the working directory.
	t.Chdir(t.TempDir())
	if EnsureDir("", 0o700, Current()) == nil || EnsureDirUnder("", "x/y", 0o700, Current()) == nil || Exists("x") {
		t.Fatal("an empty path or base must be refused")
	}
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(home, ".config")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := EnsureDirUnder(home, filepath.Join(home, ".config", "docker"), 0o755, Current()); err == nil {
		t.Fatal("a symlinked component must be refused")
	}
	if Exists(filepath.Join(target, "docker")) {
		t.Fatal("the symlink was followed")
	}
}

func mkdirMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Mkdir(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil { // not the umask's version of mode
		t.Fatal(err)
	}
}

func writeMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Mode().Perm()
}

func writeText(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// swapOnOpen plays the race the package guards against: the first time the
// code under test holds path open and is about to use it (change its mode or
// owner, read it, create a file in it), the name is moved aside to
// path+".real" and replaced by a symlink to victim, as an unprivileged
// account racing the tool would do.
func swapOnOpen(t *testing.T, path, victim string) {
	t.Helper()
	afterOpen = func(p string) {
		if p != path {
			return
		}
		afterOpen = nil
		if err := os.Rename(path, path+".real"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(victim, path); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { afterOpen = nil })
}

func TestEnsureDirNeverFollowsASymlinkSwappedInAfterTheCheck(t *testing.T) {
	for _, existing := range []bool{true, false} {
		t.Run(fmt.Sprintf("existing=%v", existing), func(t *testing.T) {
			victim, leaf := t.TempDir(), filepath.Join(t.TempDir(), "leaf")
			if err := os.Chmod(victim, 0o755); err != nil {
				t.Fatal(err)
			}
			if existing {
				mkdirMode(t, leaf, 0o755)
			}
			swapOnOpen(t, leaf, victim)
			if err := EnsureDir(leaf, 0o700, Current()); err != nil {
				t.Fatal(err)
			}
			if got := modeOf(t, victim); got != 0o755 {
				t.Fatalf("the symlink swapped in was followed: its target is now %04o", got)
			}
			if got := modeOf(t, leaf+".real"); got != 0o700 {
				t.Fatalf("the directory that was opened is %04o, want 0700", got)
			}
		})
	}
}

func TestEnsureDirUnderNeverFollowsASymlinkSwappedInAfterTheCheck(t *testing.T) {
	for _, existing := range []bool{true, false} {
		t.Run(fmt.Sprintf("existing=%v", existing), func(t *testing.T) {
			home, victim := t.TempDir(), t.TempDir()
			if err := os.Chmod(victim, 0o755); err != nil {
				t.Fatal(err)
			}
			leaf := filepath.Join(home, "leaf")
			if existing {
				mkdirMode(t, leaf, 0o755)
			}
			swapOnOpen(t, leaf, victim)
			if err := EnsureDirUnder(home, leaf, 0o700, Current()); err != nil {
				t.Fatal(err)
			}
			if got := modeOf(t, victim); got != 0o755 {
				t.Fatalf("the symlink swapped in was followed: its target is now %04o", got)
			}
			if got := modeOf(t, leaf+".real"); got != 0o700 {
				t.Fatalf("the directory that was opened is %04o, want 0700", got)
			}
		})
	}
}

func TestEnsureDirUnderNeverResolvesAComponentThroughASwappedSymlink(t *testing.T) {
	home, outside := t.TempDir(), t.TempDir()
	mkdirMode(t, filepath.Join(outside, "docker"), 0o755)
	cfg := filepath.Join(home, ".config")
	mkdirMode(t, cfg, 0o755)
	swapOnOpen(t, cfg, outside)
	if err := EnsureDirUnder(home, filepath.Join(cfg, "docker"), 0o700, Current()); err != nil {
		t.Fatal(err)
	}
	if got := modeOf(t, filepath.Join(outside, "docker")); got != 0o755 {
		t.Fatalf("a component swapped for a symlink sent the walk out of the tree: %04o", got)
	}
	if got := modeOf(t, filepath.Join(cfg+".real", "docker")); got != 0o700 {
		t.Fatalf("the leaf below the directory that was opened is %04o, want 0700", got)
	}
}

func TestEnsureDirRefusesASymlinkLeafWithoutTouchingItsTarget(t *testing.T) {
	home, target := t.TempDir(), t.TempDir()
	if err := os.Chmod(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(home, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	attempts := map[string]func() error{
		"EnsureDir": func() error { return EnsureDir(link, 0o700, Current()) },
		// A trailing slash makes the kernel follow the leaf whatever O_NOFOLLOW says.
		"EnsureDir with a trailing slash": func() error { return EnsureDir(link+"/", 0o700, Current()) },
		"EnsureDirUnder":                  func() error { return EnsureDirUnder(home, link, 0o700, Current()) },
		"EnsureDirUnder, symlink as base": func() error { return EnsureDirUnder(link, filepath.Join(link, "x"), 0o700, Current()) },
	}
	for name, run := range attempts {
		if err := run(); err == nil {
			t.Errorf("%s accepted a symlink", name)
		}
	}
	if got := modeOf(t, target); got != 0o755 {
		t.Fatalf("the symlink target was changed: %04o", got)
	}
	if Exists(filepath.Join(target, "x")) {
		t.Fatal("a symlink used as base was followed")
	}
}

func TestTightenFileRepairsTheModeAndHandsTheFileToItsOwner(t *testing.T) {
	p := filepath.Join(t.TempDir(), "runtime.env")
	writeMode(t, p, 0o644)
	svc := Owner{Current().UID + 1, Current().GID + 1}
	chowned := recordChown(t)
	var logged []string
	if err := TightenFile(p, 0o600, svc, func(f string, a ...any) {
		logged = append(logged, fmt.Sprintf(f, a...))
	}); err != nil {
		t.Fatal(err)
	}
	if got := modeOf(t, p); got != 0o600 {
		t.Fatalf("mode %04o, want 0600", got)
	}
	if chowned[p] != svc {
		t.Fatalf("owner %+v, want %+v (chowned: %v)", chowned[p], svc, chowned)
	}
	if len(logged) != 2 || !strings.Contains(logged[0], "0644") || !strings.Contains(logged[1], fmt.Sprintf("%d:%d", svc.UID, svc.GID)) {
		t.Fatalf("both repairs must be said out loud: %v", logged)
	}
}

func TestTightenFileNeverFollowsASymlinkSwappedInAfterTheCheck(t *testing.T) {
	dir := t.TempDir()
	victim, secret := filepath.Join(dir, "victim"), filepath.Join(dir, "secret")
	writeMode(t, victim, 0o644)
	writeMode(t, secret, 0o644)
	swapOnOpen(t, secret, victim)
	if err := TightenFile(secret, 0o600, Owner{-1, -1}, nil); err != nil {
		t.Fatal(err)
	}
	if got := modeOf(t, victim); got != 0o644 {
		t.Fatalf("the symlink swapped in was followed: its target is now %04o", got)
	}
	if got := modeOf(t, secret+".real"); got != 0o600 {
		t.Fatalf("the file that was opened is %04o, want 0600", got)
	}
}

func TestTightenFileRefusesWhatIsNotARegularFileWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	writeMode(t, target, 0o644)
	link, fifo := filepath.Join(dir, "link"), filepath.Join(dir, "fifo")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skip("fifos unavailable")
	}
	for name, p := range map[string]string{"symlink": link, "directory": dir, "fifo": fifo} {
		done := make(chan error, 1)
		go func() { done <- TightenFile(p, 0o600, Owner{-1, -1}, nil) }()
		select {
		case err := <-done:
			if !errors.Is(err, ErrNotRegular) {
				t.Errorf("%s: %v, want ErrNotRegular", name, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: TightenFile blocked, the leaf must be opened O_NONBLOCK", name)
		}
	}
	if got := modeOf(t, target); got != 0o644 {
		t.Fatalf("the symlink target was changed: %04o", got)
	}
}

// readers are the ways to read a file in this package, as they are called.
var readers = map[string]func(path string) ([]byte, error){
	"ReadRegular": func(path string) ([]byte, error) { return ReadRegular(path, 0o600, Current()) },
	"ReadFile":    ReadFile,
}

func TestReadsNeverFollowASymlinkSwappedInAfterTheCheck(t *testing.T) {
	for name, read := range readers {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			victim, file := filepath.Join(dir, "victim"), filepath.Join(dir, "file")
			writeText(t, victim, "root only\n")
			writeText(t, file, "service data\n")
			swapOnOpen(t, file, victim)
			got, err := read(file)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != "service data\n" {
				t.Fatalf("read %q: the symlink swapped in after the check was followed", got)
			}
		})
	}
}

func TestCopyFileNeverFollowsASymlinkSwappedInAfterTheCheck(t *testing.T) {
	dir := t.TempDir()
	victim, src, dst := filepath.Join(dir, "victim"), filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	writeText(t, victim, "root only\n")
	writeText(t, src, "service data\n")
	swapOnOpen(t, src, victim)
	if err := CopyFile(src, dst, 0o600, Current()); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, dst); got != "service data\n" {
		t.Fatalf("copied %q: the symlink swapped in after the check was followed", got)
	}
}

func TestWriteAtomicNeverFollowsADirectorySwappedInAfterTheCheck(t *testing.T) {
	for _, existing := range []bool{true, false} {
		t.Run(fmt.Sprintf("existing=%v", existing), func(t *testing.T) {
			home, victim := t.TempDir(), t.TempDir()
			dir := filepath.Join(home, "dir")
			mkdirMode(t, dir, 0o755)
			if existing {
				writeText(t, filepath.Join(dir, "target"), "old\n")
				writeText(t, filepath.Join(victim, "target"), "victim\n")
			}
			swapOnOpen(t, dir, victim)
			if err := WriteAtomic(filepath.Join(dir, "target"), []byte("new\n"), 0o600, Current()); err != nil {
				t.Fatal(err)
			}
			wantInVictim := 0
			if existing {
				wantInVictim = 1
			}
			if got := names(t, victim); len(got) != wantInVictim {
				t.Fatalf("the symlink swapped in was followed: %v", got)
			}
			if existing && readText(t, filepath.Join(victim, "target")) != "victim\n" {
				t.Fatal("a file outside the directory that was opened was replaced")
			}
			if got := readText(t, filepath.Join(dir+".real", "target")); got != "new\n" {
				t.Fatalf("the directory that was opened holds %q, want the new content", got)
			}
			if got := names(t, dir+".real"); len(got) != 1 {
				t.Fatalf("temporary file left behind: %v", got)
			}
		})
	}
}

func TestReadsRefuseWhatIsNotARegularFileWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	target, link, fifo := filepath.Join(dir, "target"), filepath.Join(dir, "link"), filepath.Join(dir, "fifo")
	writeText(t, target, "x")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skip("fifos unavailable")
	}
	attempts := map[string]func(path string) error{
		"CopyFile": func(path string) error { return CopyFile(path, filepath.Join(t.TempDir(), "dst"), 0o600, Current()) },
	}
	for name, read := range readers {
		attempts[name] = func(path string) error { _, err := read(path); return err }
	}
	for what, path := range map[string]string{"symlink": link, "directory": dir, "fifo": fifo} {
		for name, attempt := range attempts {
			done := make(chan error, 1)
			go func() { done <- attempt(path) }()
			select {
			case err := <-done:
				if !errors.Is(err, ErrNotRegular) {
					t.Errorf("%s on a %s: %v, want ErrNotRegular", name, what, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("%s on a %s blocked, the file must be opened O_NONBLOCK", name, what)
			}
		}
	}
}

// Nothing the tool creates is writable by every user, whatever a caller asks.
func TestWorldWritableModesAreRefused(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []fs.FileMode{0o666, 0o777, 0o602, 0o1777} {
		if err := WriteAtomic(filepath.Join(dir, "f"), []byte("x"), mode, Current()); !errors.Is(err, ErrWorldWritable) {
			t.Errorf("WriteAtomic %04o: %v", mode, err)
		}
		if err := EnsureDir(filepath.Join(dir, "d"), mode, Current()); !errors.Is(err, ErrWorldWritable) {
			t.Errorf("EnsureDir %04o: %v", mode, err)
		}
		if err := EnsureDirUnder(dir, filepath.Join(dir, "u", "v"), mode, Current()); !errors.Is(err, ErrWorldWritable) {
			t.Errorf("EnsureDirUnder %04o: %v", mode, err)
		}
	}
	if Exists(filepath.Join(dir, "f")) || Exists(filepath.Join(dir, "d")) || Exists(filepath.Join(dir, "u")) {
		t.Fatal("a refused mode still created something")
	}
	if err := WriteAtomic(filepath.Join(dir, "ok"), []byte("x"), 0o644, Current()); err != nil {
		t.Fatalf("0644 refused: %v", err)
	}
}
