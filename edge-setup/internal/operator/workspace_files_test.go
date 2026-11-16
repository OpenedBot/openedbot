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
	if err := os.WriteFile(filepath.Join(root, "fake.png"), []byte("API_KEY=sk-not-an-image"), 0o644); err != nil {
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
		{"fake.png", http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE"},
		{"huge.png", http.StatusRequestEntityTooLarge, "WORKSPACE_FILE_TOO_LARGE"},
		{".hidden.png", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"notes.sh", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{".env", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
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

func TestWorkspaceFileServesTextByItsExtensionAsADownload(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"notes.md":      "# Notes\n\n- un\n- deux\n- trois é\n",
		"readme.txt":    "plain",
		"table.csv":     "a,b\n1,2\n",
		"data.json":     `{"ok":true}`,
		"page.html":     "<script>alert(1)</script>",
		"old.htm":       "<p>x</p>",
		"long.markdown": "*x*",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{WorkspaceRoot: root}
	for name, want := range map[string]string{
		"notes.md":      "text/markdown; charset=utf-8",
		"long.markdown": "text/markdown; charset=utf-8",
		"readme.txt":    "text/plain; charset=utf-8",
		"table.csv":     "text/csv; charset=utf-8",
		"data.json":     "application/json; charset=utf-8",
		"page.html":     "text/html; charset=utf-8",
		"old.htm":       "text/html; charset=utf-8",
	} {
		rec := workspaceGet(t, s, name)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != want || rec.Body.String() != files[name] {
			t.Fatalf("%s: got %d %q %q", name, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
		if rec.Header().Get("Content-Disposition") != `attachment; filename="`+name+`"` ||
			rec.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
			rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s: not served as a sandboxed download: %v", name, rec.Header())
		}
	}
}

func TestWorkspaceFileRefusesTextThatIsNotTextOrNamesASecret(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "runtime.md")
	if err := os.WriteFile(outside, []byte("host secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.md")); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{
		"image.txt":       tinyPNG,
		"latin1.csv":      {'c', 'a', 'f', 0xe9},
		"empty.md":        {},
		"huge.md":         bytes.Repeat([]byte("a"), maxWorkspaceFileBytes+1),
		"secrets.json":    []byte(`{"key":"sk"}`),
		"credentials.txt": []byte("x"),
		"id_rsa.txt":      []byte("x"),
		"env.txt":         []byte("x"),
		"prod.env.md":     []byte("x"),
		"environment.md":  []byte("served: not a secret name"),
	} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{WorkspaceRoot: root}
	for _, tc := range []struct {
		name   string
		status int
		code   string
	}{
		{"escape.md", http.StatusNotFound, "WORKSPACE_FILE_NOT_FOUND"},
		{"image.txt", http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE"},
		{"latin1.csv", http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE"},
		{"empty.md", http.StatusUnsupportedMediaType, "WORKSPACE_FILE_TYPE"},
		{"huge.md", http.StatusRequestEntityTooLarge, "WORKSPACE_FILE_TOO_LARGE"},
		{"secrets.json", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"credentials.txt", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"id_rsa.txt", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"env.txt", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"prod.env.md", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
		{"..md", http.StatusBadRequest, "WORKSPACE_FILE_INVALID"},
	} {
		rec := workspaceGet(t, s, tc.name)
		if rec.Code != tc.status || workspaceErrorCode(t, rec) != tc.code {
			t.Fatalf("%s: got %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	if rec := workspaceGet(t, s, "environment.md"); rec.Code != http.StatusOK {
		t.Fatalf("environment.md: got %d %s", rec.Code, rec.Body.String())
	}
}
