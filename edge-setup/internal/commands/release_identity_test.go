package commands

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
)

// tagSignature stands for Sigstore: a "bundle" is the certificate identity
// that signed SHA256SUMS, and it verifies only when it is exactly the release
// identity of the version asked about. (The real certificate check is tested
// in internal/selfupdate against a local Sigstore instance.)
type tagSignature struct{ asked []string }

func (s *tagSignature) VerifyManifest(_ context.Context, _, bundle []byte, version string) error {
	s.asked = append(s.asked, version)
	if string(bundle) != selfupdate.ReleaseIdentity(version) {
		return errors.New("signature does not verify for " + selfupdate.ReleaseIdentity(version) + ": got " + string(bundle))
	}
	return nil
}

type servedRelease struct {
	claims   string // what the binary answers to `version`
	signedBy string // identity in the bundle; empty: unsigned (no bundle)
}

// releaseOrigin serves releases laid out like the public origin, LATEST
// naming latest, and makes `release` read from it for the test.
func releaseOrigin(t *testing.T, latest string, releases map[string]servedRelease) *tagSignature {
	t.Helper()
	files := map[string][]byte{"/LATEST": []byte(latest + "\n")}
	for v, r := range releases {
		bin := candidateTestBytes("edge-setup " + r.claims)
		files["/"+v+"/edge-setup_linux_amd64"] = bin
		files["/"+v+"/SHA256SUMS"] = []byte(selfupdate.Digest(bin) + "  edge-setup_linux_amd64\n")
		if r.signedBy != "" {
			files["/"+v+"/"+selfupdate.ManifestBundleName] = []byte(r.signedBy)
		}
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if body, ok := files[r.URL.Path]; ok {
			_, _ = w.Write(body)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	sig := &tagSignature{}
	prev := release
	t.Cleanup(func() { release = prev })
	release = func(baseURL string) (selfupdate.Release, error) {
		base := srv.URL
		if strings.HasPrefix(baseURL, "/") {
			base += baseURL // a test path such as /v0.0.3
		}
		return selfupdate.Release{BaseURL: base, HTTP: srv.Client(), Arch: "amd64", OS: "linux", Verifier: sig}, nil
	}
	return sig
}

// claimedVersion is what candidateVersion reads from a test binary.
func claimedVersion(data []byte) string {
	i := bytes.Index(data, []byte("edge-setup "))
	if i < 0 {
		return ""
	}
	return parseVersionOutput(string(data[i:]))
}

// upgradeDecision is the release path of runUpgrade (and runMacUpgrade) up to
// the point where anything is written: signed download of the requested (or
// LATEST) version, the version the binary claims, then the order check.
func upgradeDecision(installed, baseURL, version string, allow bool) (string, error) {
	c, err := releaseCandidate(context.Background(), baseURL, version)
	if err != nil {
		return "", err
	}
	return checkReleaseCandidate(installed, c.version, claimedVersion(c.data), allow)
}

func signedBy(v string) servedRelease {
	return servedRelease{claims: v, signedBy: selfupdate.ReleaseIdentity(v)}
}

func TestUpgradeReleasePathRequiresExactIdentityNewerVersionAndMatchingBinary(t *testing.T) {
	sig := releaseOrigin(t, "v0.0.4", map[string]servedRelease{
		"v0.0.2": {claims: "v0.0.2"}, // cut before signing: no bundle
		"v0.0.3": signedBy("v0.0.3"),
		"v0.0.4": signedBy("v0.0.4"),
		// Signed by the release workflow, but on another tag.
		"v0.0.5": {claims: "v0.0.5", signedBy: selfupdate.ReleaseIdentity("v0.0.4")},
		// A tag that only shares a prefix with the requested one.
		"v0.0.6": {claims: "v0.0.6", signedBy: selfupdate.ReleaseIdentity("v0.0.60")},
		// The bare prefix (what a prefix match would accept).
		"v0.0.7": {claims: "v0.0.7", signedBy: selfupdate.ReleaseIdentityPrefix},
		// A SHA256SUMS validly signed for v0.0.8 listing a binary of v0.0.9.
		"v0.0.8": {claims: "v0.0.9", signedBy: selfupdate.ReleaseIdentity("v0.0.8")},
	})
	cases := []struct {
		name, installed, version string
		allow                    bool
		wantErr                  string // empty: accepted
	}{
		{"newer signed release (LATEST)", "v0.0.3", "", false, ""},
		{"newer signed release (--version)", "v0.0.3", "v0.0.4", false, ""},
		{"wrong tag identity", "v0.0.3", "v0.0.5", false, "signature does not verify"},
		{"prefix-only identity", "v0.0.3", "v0.0.6", false, "signature does not verify"},
		{"bare prefix identity", "v0.0.3", "v0.0.7", false, "signature does not verify"},
		{"wrong tag identity, even with --allow-downgrade", "v0.0.9", "v0.0.5", true, "signature does not verify"},
		{"downgrade refused", "v0.0.4", "v0.0.3", false, "older than the installed"},
		{"equal version refused", "v0.0.4", "", false, "already the installed version"},
		{"equal version refused (--version)", "v0.0.3", "v0.0.3", false, "already the installed version"},
		{"downgrade with --allow-downgrade and its own signature", "v0.0.4", "v0.0.3", true, ""},
		{"downgrade with --allow-downgrade to an unsigned release", "v0.0.4", "v0.0.2", true, "carries no signature"},
		{"upgrade to an unsigned release", "v0.0.1", "v0.0.2", false, "carries no signature"},
		{"binary claims another version than its signed tag", "v0.0.3", "v0.0.8", false, "version mismatch"},
		{"version mismatch, even with --allow-downgrade", "v0.0.9", "v0.0.8", true, "version mismatch"},
		{"unorderable installed build", "dev", "v0.0.4", false, "cannot be ordered"},
	}
	for _, c := range cases {
		sig.asked = nil
		_, err := upgradeDecision(c.installed, "", c.version, c.allow)
		if c.wantErr == "" && err != nil {
			t.Errorf("%s: refused: %v", c.name, err)
		}
		if c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
			t.Errorf("%s: got %v, want an error containing %q", c.name, err, c.wantErr)
		}
		// The signature is only ever checked for the requested tag.
		want := c.version
		if want == "" {
			want = "v0.0.4"
		}
		for _, v := range sig.asked {
			if v != want {
				t.Errorf("%s: signature checked for %s, want only %s", c.name, v, want)
			}
		}
	}
}

// --version and a versioned --release-url must agree: the files of one
// release are never verified against another tag.
func TestUpgradeVersionAndVersionedReleaseURLMustAgree(t *testing.T) {
	releaseOrigin(t, "v0.0.4", map[string]servedRelease{"v0.0.3": signedBy("v0.0.3"), "v0.0.4": signedBy("v0.0.4")})
	if _, err := upgradeDecision("v0.0.2", "/v0.0.3", "v0.0.4", false); err == nil || !strings.Contains(err.Error(), "serves v0.0.3") {
		t.Fatalf("v0.0.3 URL with --version v0.0.4: %v", err)
	}
	if _, err := upgradeDecision("v0.0.2", "/v0.0.3", "v0.0.3", false); err != nil {
		t.Fatalf("v0.0.3 URL with --version v0.0.3: %v", err)
	}
	var out, errb bytes.Buffer
	env := cli.Env{Version: "v0.0.2", Stdout: &out, Stderr: &errb}
	if code := runUpgrade(env, []string{"--yes", "--release-url", "https://releases.example/edge-setup/v0.0.3", "--version", "v0.0.4"}); code != cli.ExitUsage || !strings.Contains(errb.String(), "serves v0.0.3") {
		t.Fatalf("runUpgrade mixed URL/version: code=%d err=%q", code, errb.String())
	}
	for _, v := range []string{"v0.0.*", "v0.0.4/../v0.0.2", "v00.0.4", "v0.0.4\n", "edge-setup/v0.0.4"} {
		errb.Reset()
		if code := runUpgrade(env, []string{"--yes", "--version", v}); code != cli.ExitUsage {
			t.Errorf("--version %q: code=%d err=%q", v, code, errb.String())
		}
	}
}

// self-verify checks the binary against the release of its own version,
// never LATEST: a build that is not a release has nothing to verify against.
func TestSelfVerifyUsesTheInstalledVersionIdentity(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("release platforms only")
	}
	sig := releaseOrigin(t, "v0.0.4", map[string]servedRelease{"v0.0.3": signedBy("v0.0.3"), "v0.0.4": signedBy("v0.0.4")})
	for _, v := range []string{"dev", "v0.0.3-2-gabc1234", "v0.0.3-dirty", ""} {
		var out, errb bytes.Buffer
		if code := runSelfVerify(cli.Env{Version: v, Stdout: &out, Stderr: &errb}, nil); code != cli.ExitRefused || !strings.Contains(errb.String(), "not a published") {
			t.Errorf("self-verify of %q: code=%d err=%q", v, code, errb.String())
		}
	}
	var out, errb bytes.Buffer
	// The test binary is listed in no release: the point is which tag the
	// signature was checked for (v0.0.3, not LATEST v0.0.4).
	code := runSelfVerify(cli.Env{Version: "v0.0.3", Stdout: &out, Stderr: &errb}, nil)
	if code != cli.ExitFailure || strings.Join(sig.asked, ",") != "v0.0.3" {
		t.Fatalf("self-verify v0.0.3: code=%d asked=%v err=%q", code, sig.asked, errb.String())
	}
	sig.asked = nil
	errb.Reset()
	if code := runSelfVerify(cli.Env{Version: "v0.0.3", Stdout: &out, Stderr: &errb}, []string{"--release-url", "/v0.0.4"}); code != cli.ExitRefused || len(sig.asked) != 0 {
		t.Fatalf("self-verify v0.0.3 against a v0.0.4 URL: code=%d asked=%v err=%q", code, sig.asked, errb.String())
	}
}
