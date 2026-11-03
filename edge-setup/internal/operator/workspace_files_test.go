package operator

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

var tinyPNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

func workspaceGet(t *testing.T, s *Server, name string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/workspace/files/"+name, nil))
	return rec
}

func workspaceErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var doc struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("not an error document: %q", rec.Body.String())
	}
	return doc.Error.Code
}

func TestWorkspaceFileServesAnImageByItsBytes(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "chart.png"), tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	rec := workspaceGet(t, &Server{WorkspaceRoot: root}, "chart.png")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rec.Body.Bytes(), tinyPNG) {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("the response must not be sniffed")
	}
}

func TestWorkspaceFileRefusesWhatIsNotAPlainViewableFile(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "runtime.png")
	if err := os.WriteFile(outside, tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "secret.png"), []byte("API_KEY=sk-not-an-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "huge.png"), append(append([]byte{}, tinyPNG...), make([]byte, maxWorkspaceFileBytes)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(root, "pipe.png"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{WorkspaceRoot: root}
	for _, tc := range []struct {
		name   string
		status int
		code   string
	}{
		{"escape.png", http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND"},
		{"missing.png", http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND"},
		{"dir.png", http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND"},
		{"pipe.png", http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND"},
		{"secret.png", http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE"},
		{"huge.png", http.StatusRequestEntityTooLarge, "WORKSPACE_FILE_TOO_LARGE"},
		{".hidden.png", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"notes.txt", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
	} {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- workspaceGet(t, s, tc.name) }()
		select {
		case rec := <-done:
			if rec.Code != tc.status || workspaceErrorCode(t, rec) != tc.code {
				t.Fatalf("%s: got %d %s", tc.name, rec.Code, rec.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: the read hung", tc.name)
		}
	}
	// A nested path never reaches the handler: one segment only.
	if rec := workspaceGet(t, s, "sub/chart.png"); rec.Code == http.StatusOK {
		t.Fatal("a nested path was served")
	}
}

func TestWorkspaceFileIsOffWithoutAWorkspaceRoot(t *testing.T) {
	rec := workspaceGet(t, &Server{}, "chart.png")
	if rec.Code != http.StatusNotFound || workspaceErrorCode(t, rec) != "WORKSPACE_FILES_UNSUPPORTED" {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}
