package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSums(t *testing.T) {
	m := Sums("abc  edge-setup_linux_amd64\ndef *edge-setup_linux_arm64\n\n")
	if m["edge-setup_linux_amd64"] != "abc" || m["edge-setup_linux_arm64"] != "def" {
		t.Fatalf("%v", m)
	}
}

func selfManifest(t *testing.T, asset string) string {
	t.Helper()
	self, _ := os.Executable()
	data, _ := os.ReadFile(self)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) + "  " + asset + "\n"
}

// releaseServer serves a manifest and a binary under name; hits counts
// requests.
func releaseServer(t *testing.T, manifest string, name string, binary []byte, hits *int32) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		switch {
		case strings.HasSuffix(r.URL.Path, "/SHA256SUMS") && manifest != "":
			_, _ = w.Write([]byte(manifest))
		case strings.HasSuffix(r.URL.Path, "/"+ManifestBundleName) && manifest != "":
			_, _ = w.Write([]byte(testBundle))
		case strings.HasSuffix(r.URL.Path, "/"+name) && binary != nil:
			_, _ = w.Write(binary)
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestVerifyAgainstManifest(t *testing.T) {
	var hits int32
	srv := releaseServer(t, selfManifest(t, "edge-setup_linux_amd64"), "edge-setup_linux_amd64", nil, &hits)
	defer srv.Close()
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	if err := r.Verify(context.Background()); err != nil {
		t.Fatalf("listed binary refused: %v", err)
	}
	r.Arch = "arm64"
	if err := r.Verify(context.Background()); err == nil || !strings.Contains(err.Error(), "does not list") {
		t.Fatalf("unlisted asset must fail: %v", err)
	}
}

// A release cut at or before v0.4.0 lists only the pre-rename asset name; a
// new binary must still verify and upgrade from it.
func TestVerifyFallsBackToLegacyAssetName(t *testing.T) {
	var hits int32
	srv := releaseServer(t, selfManifest(t, "hermes-setup_linux_amd64"), "hermes-setup_linux_amd64", nil, &hits)
	defer srv.Close()
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	if err := r.Verify(context.Background()); err != nil {
		t.Fatalf("legacy-named listed binary refused: %v", err)
	}
}

// The SHA-256 binds the downloaded binary to the manifest: a binary that
// differs from what SHA256SUMS lists is never returned.
func TestDownloadRefusesABinaryThatDoesNotMatchTheManifest(t *testing.T) {
	binary := []byte("\x7fELF release")
	manifest := Digest(binary) + "  edge-setup_linux_amd64\n"
	var hits int32
	srv := releaseServer(t, manifest, "edge-setup_linux_amd64", binary, &hits)
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	data, sum, err := r.Download(context.Background())
	if err != nil || string(data) != string(binary) || sum != Digest(binary) {
		t.Fatalf("matching binary: %q %s %v", data, sum, err)
	}
	srv.Close()
	srv = releaseServer(t, manifest, "edge-setup_linux_amd64", []byte("\x7fELF substituted"), &hits)
	defer srv.Close()
	r = Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	if _, _, err := r.Download(context.Background()); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("substituted binary accepted: %v", err)
	}
}

// Download must also fetch under the legacy asset name when the manifest
// only lists that one (a release cut at or before v0.4.0).
func TestDownloadFallsBackToLegacyAssetName(t *testing.T) {
	binary := []byte("\x7fELF release")
	manifest := Digest(binary) + "  hermes-setup_linux_amd64\n"
	var hits int32
	srv := releaseServer(t, manifest, "hermes-setup_linux_amd64", binary, &hits)
	defer srv.Close()
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	data, sum, err := r.Download(context.Background())
	if err != nil || string(data) != string(binary) || sum != Digest(binary) {
		t.Fatalf("legacy-named binary: %q %s %v", data, sum, err)
	}
}

func TestMissingOrEmptyManifestIsRefused(t *testing.T) {
	var hits int32
	srv := releaseServer(t, "", "edge-setup_linux_amd64", nil, &hits)
	defer srv.Close()
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	if _, err := r.Manifest(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("missing manifest must fail: %v", err)
	}
	empty := releaseServer(t, "garbage\n", "edge-setup_linux_amd64", nil, &hits)
	defer empty.Close()
	r.BaseURL, r.HTTP = empty.URL, empty.Client()
	if _, err := r.Manifest(context.Background()); err == nil || !strings.Contains(err.Error(), "no asset") {
		t.Fatalf("empty manifest must fail: %v", err)
	}
}

func TestParseBaseURLRefusesNonHTTPS(t *testing.T) {
	for _, bad := range []string{"http://example.com/x", "ftp://example.com", "https://", "https://user:pw@example.com/x", "https://example.com/x?y=1", "https://example.com/x#f", "https://example.com/../x", "example.com/x"} {
		if _, err := ParseBaseURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	got, err := ParseBaseURL(" https://example.com/releases/download/v1/ ")
	if err != nil || got != "https://example.com/releases/download/v1" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := DefaultRelease("amd64", "http://example.com/x"); err == nil {
		t.Fatal("DefaultRelease accepted a plain http base URL")
	}
}

func TestDefaultReleaseUsesOpenedBotReleases(t *testing.T) {
	rel, err := DefaultRelease("amd64", "")
	if err != nil || rel.BaseURL != "https://releases.openedbot.app/edge-setup" {
		t.Fatalf("default base: %q err=%v", rel.BaseURL, err)
	}
}

func TestParseBaseURLRefusesLegacyGitHubBase(t *testing.T) {
	for _, legacy := range []string{
		"https://github.com/MakFly/edge-setup-releases/releases/latest/download",
		"https://github.com/makfly/edge-setup-releases/releases/download/v0.5.9/",
		"https://www.github.com/MakFly/edge-setup-releases/releases/latest/download",
		"https://GitHub.com/OpenedBot/edge-setup-releases/releases/latest/download",
		"https://github.com/MakFly/edge-setup-releases",
	} {
		if _, err := ParseBaseURL(legacy); !errors.Is(err, ErrLegacyGitHubBase) {
			t.Errorf("%q: err=%v, want ErrLegacyGitHubBase", legacy, err)
		}
		if _, err := DefaultRelease("amd64", legacy); !errors.Is(err, ErrLegacyGitHubBase) {
			t.Errorf("DefaultRelease %q: err=%v, want ErrLegacyGitHubBase", legacy, err)
		}
	}
	// A mirror is still accepted, on GitHub or elsewhere, as long as it is
	// not the retired public releases repository.
	for _, mirror := range []string{
		"https://github.com/acme/edge-mirror/releases/latest/download",
		"https://mirror.example.com/edge-setup-releases/v1",
	} {
		if _, err := ParseBaseURL(mirror); err != nil {
			t.Errorf("%q refused: %v", mirror, err)
		}
	}
}

func TestFetchRefusesRedirectToHTTP(t *testing.T) {
	var plainHits int32
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&plainHits, 1)
		_, _ = w.Write([]byte("x  edge-setup_linux_amd64\n"))
	}))
	defer plain.Close()
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+r.URL.Path, http.StatusFound)
	}))
	defer tls.Close()
	client := NewHTTPClient()
	client.Transport = tls.Client().Transport
	r := Release{BaseURL: tls.URL, HTTP: client, Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	_, err := r.Manifest(context.Background())
	if err == nil || !strings.Contains(err.Error(), "only https") {
		t.Fatalf("redirect to http accepted: %v", err)
	}
	if plainHits != 0 {
		t.Fatalf("the http server was reached %d times", plainHits)
	}
	// A plain base URL never leaves the process.
	r.BaseURL = plain.URL
	if _, err := r.Manifest(context.Background()); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("http base URL accepted: %v", err)
	}
}
