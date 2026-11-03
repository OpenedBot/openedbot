package operator

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"syscall"
)

// A bot shows the operator a file it made by writing it in the terminal
// sandbox's `/workspace` and replying `MEDIA:/workspace/<name>`. Hermes only
// turns that line into an inline image on its chat routes; `/v1/runs`, the
// one openedbot drives, returns it as is (gateway/platforms/api_server_runs.py
// `_finish(..., output=result["final_response"])`, measured on VM 240,
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
