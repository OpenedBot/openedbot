package operator

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// A bot shows the operator a file it made by writing it in the terminal
// sandbox's `/workspace` and replying `MEDIA:/workspace/<name>`. Hermes only
// turns that line into an inline image on its chat routes; `/v1/runs`, the
// one openedbot drives, returns it as is (gateway/platforms/api_server_runs.py
// `_finish(..., output=result["final_response"])`, measured on the lab host,
// 2026-11-03). This route lets the worker fetch the file to attach it.
//
// It is a READ of one bounded name, never a path: no directory, no dot
// segment, no hidden file, a fixed list of extensions. The bytes must also
// BE an image or a PDF (magic number), whatever the name says. The bot owns
// the workspace and may plant a symlink or a FIFO there: os.Root refuses any
// resolution that leaves the root, O_NONBLOCK keeps a FIFO from hanging the
// open, and anything but a regular file is refused.

// maxWorkspaceFileBytes is openedbot's per-attachment bound
// (ATTACHMENT_LIMITS.maxBytesEach); the relay's response bound is 4 MiB.
const maxWorkspaceFileBytes = 1 << 20

var workspaceFileRe = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(png|jpg|jpeg|webp|pdf)$`)

var errWorkspaceFileType = errors.New("not an image or a PDF")

// sniffWorkspaceFile names the content type from the bytes alone.
func sniffWorkspaceFile(data []byte) (string, error) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png", nil
	case bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg", nil
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp", nil
	case bytes.HasPrefix(data, []byte("%PDF-")):
		return "application/pdf", nil
	}
	return "", errWorkspaceFileType
}

func (s *Server) workspaceFile(w http.ResponseWriter, r *http.Request) {
	if s.WorkspaceRoot == "" {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILES_UNSUPPORTED", "this host serves no workspace files")
		return
	}
	name := r.PathValue("file")
	if !workspaceFileRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "WORKSPACE_FILE_INVALID", "the file name is invalid")
		return
	}
	root, err := os.OpenRoot(s.WorkspaceRoot)
	if err != nil {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND", "this file does not exist")
		return
	}
	defer root.Close()
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND", "this file does not exist")
		return
	}
	defer file.Close()
	writeWorkspaceFile(w, file)
}

// The named route reads the profile's own workspace when the profile is
// proven isolated. A profile made before isolation mounts the root
// `workspaces` that every such profile shares: there, and only on that proof,
// a file is served when it was written within the last
// sharedWorkspaceRecentWindow, the trust Hermes itself gives a delivery
// (gateway/platforms/base.py, HERMES_MEDIA_TRUST_RECENT_SECONDS, 600 s). Any
// other policy is refused. The proof is read afresh through the same
// projection Hermes binds per turn; directory traversal is anchored by
// no-follow FDs.
func (s *Server) profileWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	profile, name := r.PathValue("slug"), r.PathValue("file")
	if !profileSlugRe.MatchString(profile) || profile == "default" || !workspaceFileRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "WORKSPACE_FILE_INVALID", "the profile or file name is invalid")
		return
	}
	if s.InventoryRoots.RuntimeRoot == "" || s.Probe == nil {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILES_UNSUPPORTED", "this host serves no isolated profile workspace files")
		return
	}
	var proof struct {
		Profile    string `json:"profile"`
		Isolated   bool   `json:"isolated"`
		SharedRoot bool   `json:"sharedRoot"`
	}
	if err := s.runProbe(r.Context(), "profile-workspace", map[string]string{"name": profile}, &proof); err != nil {
		s.writeProbeFailure(w, "profile-workspace", err)
		return
	}
	var directory *os.File
	var err error
	recentOnly := false
	switch {
	case proof.Profile != profile:
		err = errors.New("proof for another profile")
	case proof.Isolated:
		directory, err = openProfileWorkspace(s.InventoryRoots.RuntimeRoot, profile)
	case proof.SharedRoot && s.sharedRootIsTheRuntimeOne():
		directory, err = openNoFollowDirectory(s.WorkspaceRoot)
		recentOnly = true
	default:
		err = errors.New("no proven workspace")
	}
	if err != nil {
		writeError(w, http.StatusConflict, "PROFILE_WORKSPACE_UNVERIFIED", "the profile has no proven workspace")
		return
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND", "this file does not exist")
		return
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	if recentOnly && !recentlyWritten(file, s.now()) {
		// Same answer as a missing file: an old file of another bot stays
		// invisible, its existence included.
		writeError(w, http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND", "this file does not exist")
		return
	}
	writeWorkspaceFile(w, file)
}

// sharedWorkspaceRecentWindow is Hermes' default delivery trust window.
const sharedWorkspaceRecentWindow = 600 * time.Second

// sharedWorkspaceClockSkew tolerates a container clock slightly ahead; a
// file dated further in the future is refused, so a bot cannot make one of
// its files "recent" forever with `touch -d`.
const sharedWorkspaceClockSkew = 60 * time.Second

func recentlyWritten(file *os.File, now time.Time) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	age := now.Sub(info.ModTime())
	return age <= sharedWorkspaceRecentWindow && age >= -sharedWorkspaceClockSkew
}

// The probe proves a mount of `<runtime>/workspaces`; serve it only when that
// is exactly the root this server reads.
func (s *Server) sharedRootIsTheRuntimeOne() bool {
	return s.WorkspaceRoot != "" && s.InventoryRoots.RuntimeRoot != "" &&
		filepath.Clean(s.WorkspaceRoot) == filepath.Join(s.InventoryRoots.RuntimeRoot, "workspaces")
}

func openNoFollowDirectory(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "shared-workspace"), nil
}

func openProfileWorkspace(runtimeRoot, profile string) (*os.File, error) {
	fd, err := unix.Open(runtimeRoot, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range []string{"profiles", profile, "workspace"} {
		next, nextErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		_ = unix.Close(fd)
		if nextErr != nil {
			return nil, nextErr
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), "profile-workspace"), nil
}

func writeWorkspaceFile(w http.ResponseWriter, file *os.File) {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND", "this file does not exist")
		return
	}
	if info.Size() > maxWorkspaceFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "WORKSPACE_FILE_TOO_LARGE", "the file exceeds its bound")
		return
	}
	// The size can still grow between Stat and Read: read one byte past the bound.
	data, err := io.ReadAll(io.LimitReader(file, maxWorkspaceFileBytes+1))
	if err != nil {
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not complete this operation")
		return
	}
	if len(data) > maxWorkspaceFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "WORKSPACE_FILE_TOO_LARGE", "the file exceeds its bound")
		return
	}
	contentType, err := sniffWorkspaceFile(data)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE", "the file is not an image or a PDF")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
