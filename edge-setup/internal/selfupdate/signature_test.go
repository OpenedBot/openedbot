package selfupdate

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

const (
	testVersion = "v9.9.9"
	testBundle  = `{"fake":"bundle"}`
)

// acceptSignature stands for a valid signature: it accepts the test bundle
// and nothing else.
type acceptSignature struct{}

func (acceptSignature) VerifyManifest(_ context.Context, _, bundle []byte, version string) error {
	if string(bundle) != testBundle || !stableVersion.MatchString(version) {
		return errors.New("fake verifier: refused")
	}
	return nil
}

// recordSignature records the version it was asked about and answers err.
type recordSignature struct {
	mu       sync.Mutex
	versions []string
	err      error
}

func (r *recordSignature) VerifyManifest(_ context.Context, _, _ []byte, version string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.versions = append(r.versions, version)
	return r.err
}

// signedServer serves a release laid out like the public origin: LATEST at
// the root, every file of the release under /vX.Y.Z/. paths records each
// request.
func signedServer(t *testing.T, latest string, files map[string]string, paths *[]string) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*paths = append(*paths, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/"+LatestPointerName && latest != "" {
			_, _ = w.Write([]byte(latest))
			return
		}
		if body, ok := files[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func signedRelease(binary string) map[string]string {
	return map[string]string{
		"/v1.2.3/SHA256SUMS":             Digest([]byte(binary)) + "  edge-setup_linux_amd64\n",
		"/v1.2.3/" + ManifestBundleName:  testBundle,
		"/v1.2.3/edge-setup_linux_amd64": binary,
	}
}

func TestManifestWithoutVerifierIsRefused(t *testing.T) {
	var paths []string
	srv := signedServer(t, "v1.2.3\n", signedRelease("\x7fELF bin"), &paths)
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Arch: "amd64"}
	if _, err := r.Manifest(context.Background()); err == nil || !strings.Contains(err.Error(), "no signature verifier") {
		t.Fatalf("a release was read without a verifier: %v", err)
	}
}

// The latest release is resolved once, through LATEST, and every file is then
// read from that version directory; the verifier is asked about that version.
func TestDownloadResolvesLatestOnceAndVerifiesItsSignature(t *testing.T) {
	binary := "\x7fELF bin"
	var paths []string
	srv := signedServer(t, "v1.2.3\n", signedRelease(binary), &paths)
	sig := &recordSignature{}
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Arch: "amd64", Verifier: sig}
	data, sum, err := r.Download(context.Background())
	if err != nil || string(data) != binary || sum != Digest([]byte(binary)) {
		t.Fatalf("signed release: %q %s %v", data, sum, err)
	}
	want := []string{"/LATEST", "/v1.2.3/SHA256SUMS", "/v1.2.3/" + ManifestBundleName, "/v1.2.3/edge-setup_linux_amd64"}
	if strings.Join(paths, " ") != strings.Join(want, " ") {
		t.Fatalf("requests %v, want %v", paths, want)
	}
	if strings.Join(sig.versions, " ") != "v1.2.3" {
		t.Fatalf("verifier asked about %v, want v1.2.3", sig.versions)
	}
}

// A signature that does not verify stops everything before the binary is
// even requested.
func TestInvalidSignatureIsRefusedBeforeTheBinaryIsFetched(t *testing.T) {
	var paths []string
	srv := signedServer(t, "v1.2.3", signedRelease("\x7fELF bin"), &paths)
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Arch: "amd64", Verifier: &recordSignature{err: errors.New("bad signature")}}
	if _, _, err := r.Download(context.Background()); err == nil || !strings.Contains(err.Error(), "bad signature") {
		t.Fatalf("invalid signature accepted: %v", err)
	}
	for _, p := range paths {
		if strings.HasSuffix(p, "edge-setup_linux_amd64") {
			t.Fatalf("binary fetched despite an invalid signature: %v", paths)
		}
	}
}

// A release that serves no bundle is unsigned: refused, never trusted on its
// checksum alone.
func TestMissingSignatureIsRefused(t *testing.T) {
	files := signedRelease("\x7fELF bin")
	delete(files, "/v1.2.3/"+ManifestBundleName)
	var paths []string
	srv := signedServer(t, "v1.2.3", files, &paths)
	sig := &recordSignature{}
	r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Arch: "amd64", Verifier: sig}
	if _, _, err := r.Download(context.Background()); !errors.Is(err, ErrUnsigned) {
		t.Fatalf("unsigned release: %v, want ErrUnsigned", err)
	}
	if len(sig.versions) != 0 {
		t.Fatal("verifier called without a bundle")
	}
}

func TestLatestPointerMustNameAStableVersion(t *testing.T) {
	for _, latest := range []string{"latest", "v1.2", "v1.2.3-rc1", "../v1.2.3", "v1.2.3\nv1.2.4"} {
		var paths []string
		srv := signedServer(t, latest, signedRelease("\x7fELF bin"), &paths)
		r := Release{BaseURL: srv.URL, HTTP: srv.Client(), Arch: "amd64", Verifier: &recordSignature{}}
		if _, err := r.Manifest(context.Background()); err == nil || !strings.Contains(err.Error(), "not vX.Y.Z") {
			t.Errorf("LATEST %q accepted: %v", latest, err)
		}
	}
}

// A versioned base URL pins the release: LATEST is not read.
func TestVersionedBaseURLSkipsTheLatestPointer(t *testing.T) {
	var paths []string
	srv := signedServer(t, "v9.0.0", signedRelease("\x7fELF bin"), &paths)
	sig := &recordSignature{}
	r := Release{BaseURL: srv.URL + "/v1.2.3", HTTP: srv.Client(), Arch: "amd64", Verifier: sig}
	if _, err := r.Manifest(context.Background()); err != nil {
		t.Fatal(err)
	}
	if paths[0] != "/v1.2.3/SHA256SUMS" || strings.Join(sig.versions, " ") != "v1.2.3" {
		t.Fatalf("requests %v, versions %v", paths, sig.versions)
	}
}

func TestSigstoreVerifierRefusesOffline(t *testing.T) {
	v := SigstoreVerifier{CachePath: t.TempDir()}
	if err := v.VerifyManifest(context.Background(), []byte("x"), []byte(testBundle), "latest"); err == nil || !strings.Contains(err.Error(), "not vX.Y.Z") {
		t.Fatalf("non-release version accepted: %v", err)
	}
	if err := v.VerifyManifest(context.Background(), []byte("x"), []byte("not json"), "v1.2.3"); err == nil || !strings.Contains(err.Error(), "signature bundle") {
		t.Fatalf("garbage bundle accepted: %v", err)
	}
}

func TestReleaseIdentityIsTheTagRunOfTheReleaseWorkflow(t *testing.T) {
	got := ReleaseIdentity("v1.2.3")
	want := "https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/v1.2.3"
	if got != want {
		t.Fatalf("%s, want %s", got, want)
	}
}

// TestSigstoreVerifierOnARealBundle runs the real verification (Sigstore TUF
// over the network) against a public keyless bundle: cosign's own release
// manifest. EDGE_SETUP_LIVE_SIGSTORE=1 enables it.
func TestSigstoreVerifierOnARealBundle(t *testing.T) {
	if os.Getenv("EDGE_SETUP_LIVE_SIGSTORE") != "1" {
		t.Skip("EDGE_SETUP_LIVE_SIGSTORE=1 runs the networked Sigstore verification")
	}
	artifact, err := os.ReadFile("testdata/cosign_checksums.txt")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/cosign_checksums.txt.sigstore.json")
	if err != nil {
		t.Fatal(err)
	}
	const issuer, san = "https://accounts.google.com", "keyless@projectsigstore.iam.gserviceaccount.com"
	v := SigstoreVerifier{CachePath: t.TempDir()}
	if err := v.verify(artifact, raw, issuer, san); err != nil {
		t.Fatalf("valid bundle refused: %v", err)
	}
	if err := v.verify(append(artifact, '\n'), raw, issuer, san); err == nil {
		t.Fatal("tampered artifact accepted")
	}
	if err := v.verify(artifact, raw, SigstoreIssuer, ReleaseIdentity("v1.2.3")); err == nil {
		t.Fatal("bundle accepted for another identity")
	}
}
