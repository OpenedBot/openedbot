package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestFetchVerifiesDigestBeforeWriting(t *testing.T) {
	body := []byte("pinned artefact\n")
	sum := sha256.Sum256(body)
	want := hex.EncodeToString(sum[:])
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	c := Client{HTTP: srv.Client(), Retries: 1, Backoff: time.Millisecond}
	dest := filepath.Join(t.TempDir(), "artefact")

	if err := c.Fetch(context.Background(), srv.URL+"/a", dest, SHA256, "0000", 0o644, fsx.Current()); !errors.Is(err, ErrChecksum) {
		t.Fatalf("wrong digest must be refused: %v", err)
	}
	if _, err := os.Stat(dest); err == nil {
		t.Fatal("a file with a wrong digest was written")
	}
	if err := c.Fetch(context.Background(), srv.URL+"/a", dest, SHA256, want, 0o644, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	if ok, _ := VerifyFile(dest, SHA256, want); !ok {
		t.Fatal("verify after fetch")
	}
	entries, _ := os.ReadDir(filepath.Dir(dest))
	if len(entries) != 1 {
		t.Fatalf("temporary download left behind: %v", entries)
	}
}

func TestFetchRefusesPlainHTTP(t *testing.T) {
	c := Default()
	if err := c.Fetch(context.Background(), "http://example.invalid/x", filepath.Join(t.TempDir(), "x"), SHA256, "00", 0o644, fsx.Current()); err == nil {
		t.Fatal("http:// must be refused")
	}
}

func TestFetchRetriesTransientFailures(t *testing.T) {
	body := []byte("x")
	sum := sha256.Sum256(body)
	calls := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	c := Client{HTTP: srv.Client(), Retries: 3, Backoff: time.Millisecond}
	if err := c.Fetch(context.Background(), srv.URL+"/x", filepath.Join(t.TempDir(), "x"), SHA256, hex.EncodeToString(sum[:]), 0o644, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestFetchWithoutAnHTTPClientFailsInsteadOfPanicking(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "artefact")
	err := Client{}.Fetch(context.Background(), "https://example.invalid/x.tar.xz", dest, SHA256, strings.Repeat("0", 64), 0o644, fsx.Current())
	if err == nil || !strings.Contains(err.Error(), "no HTTP client") {
		t.Fatalf("err = %v", err)
	}
	if fsx.Exists(dest) {
		t.Fatal("nothing must be written")
	}
}
