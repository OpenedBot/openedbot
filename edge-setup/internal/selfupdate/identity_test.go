package selfupdate

import (
	"strings"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// localVerifierOptions are the production thresholds minus the embedded SCT,
// which sigstore-go's in-memory test instance does not issue. The identity
// policy under test (verifyEntity) is the production one.
func localVerifierOptions() []verify.VerifierOption {
	return []verify.VerifierOption{verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1)}
}

func TestProductionVerifierRequiresSCTLogAndTimestamp(t *testing.T) {
	if n := len(productionVerifierOptions()); n != 3 {
		t.Fatalf("production verifier has %d thresholds, want SCT, transparency log and observer timestamp", n)
	}
}

// The release identity of a version is checked as one exact value, against a
// real signature from a local Sigstore instance: the signature of its own tag
// verifies; another tag, a tag that only shares a prefix with it, the bare
// prefix, another workflow or another issuer does not.
func TestReleaseSignatureRequiresTheExactTagIdentity(t *testing.T) {
	vs, err := ca.NewVirtualSigstore()
	if err != nil {
		t.Fatal(err)
	}
	manifest := []byte("0123  edge-setup_linux_amd64\n")
	sign := func(t *testing.T, identity, issuer string) verify.SignedEntity {
		t.Helper()
		e, err := vs.Sign(identity, issuer, manifest)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	const want = "v0.0.3"
	good := sign(t, ReleaseIdentity(want), SigstoreIssuer)
	if err := verifyEntity(vs, good, manifest, SigstoreIssuer, ReleaseIdentity(want), localVerifierOptions()...); err != nil {
		t.Fatalf("signature of edge-setup/%s refused: %v", want, err)
	}
	if err := verifyEntity(vs, good, append(manifest, '\n'), SigstoreIssuer, ReleaseIdentity(want), localVerifierOptions()...); err == nil {
		t.Fatal("tampered SHA256SUMS accepted")
	}
	for name, signer := range map[string]struct{ identity, issuer string }{
		"another tag":            {ReleaseIdentity("v0.0.2"), SigstoreIssuer},
		"a newer tag":            {ReleaseIdentity("v0.0.4"), SigstoreIssuer},
		"tag sharing the prefix": {ReleaseIdentity("v0.0.30"), SigstoreIssuer},
		"tag with a suffix":      {ReleaseIdentity("v0.0.3-rc1"), SigstoreIssuer},
		"tag with a path":        {ReleaseIdentity("v0.0.3/evil"), SigstoreIssuer},
		"tag prefix only":        {ReleaseIdentityPrefix, SigstoreIssuer},
		"truncated tag":          {ReleaseIdentity("v0.0"), SigstoreIssuer},
		"another workflow":       {strings.Replace(ReleaseIdentity(want), "edge-setup-release.yml", "other.yml", 1), SigstoreIssuer},
		"a branch":               {strings.Replace(ReleaseIdentity(want), "refs/tags/", "refs/heads/", 1), SigstoreIssuer},
		"another issuer":         {ReleaseIdentity(want), "https://accounts.google.com"},
	} {
		e := sign(t, signer.identity, signer.issuer)
		if err := verifyEntity(vs, e, manifest, SigstoreIssuer, ReleaseIdentity(want), localVerifierOptions()...); err == nil || !strings.Contains(err.Error(), "certificate identity") {
			t.Errorf("%s (%s, %s) not refused on its identity for edge-setup/%s: %v", name, signer.identity, signer.issuer, want, err)
		}
	}
	// The policy never degrades to "any identity" on an empty expectation.
	if err := verifyEntity(vs, good, manifest, SigstoreIssuer, "", localVerifierOptions()...); err == nil {
		t.Fatal("empty identity accepted")
	}
	if err := verifyEntity(vs, good, manifest, "", ReleaseIdentity(want), localVerifierOptions()...); err == nil {
		t.Fatal("empty issuer accepted")
	}
}

func TestStableVersionIsStrict(t *testing.T) {
	for _, v := range []string{"v0.0.3", "v1.20.300", "v10.0.0"} {
		if !IsStableVersion(v) {
			t.Errorf("%q refused", v)
		}
	}
	for _, v := range []string{"", "v", "0.0.3", "v0.0", "v0.0.3.4", "v0.0.3-rc1", "v0.0.3+b", "v00.0.3", "v0.01.3", "v0.0.*", "v0.0.3*", "v0.0.3 ", " v0.0.3", "v0.0.3\n", "v0.0.3/x", "../v0.0.3", "v0.0.3\x00"} {
		if IsStableVersion(v) {
			t.Errorf("%q accepted", v)
		}
	}
}

// Pin fixes the release to the requested version and refuses a base URL that
// serves another one; Resolve refuses the same mix.
func TestPinRefusesAnotherVersionInTheBaseURL(t *testing.T) {
	r, err := Release{BaseURL: "https://releases.example/edge-setup"}.Pin("v0.0.3")
	if err != nil || r.BaseURL != "https://releases.example/edge-setup/v0.0.3" || r.Version != "v0.0.3" {
		t.Fatalf("pin: %+v %v", r, err)
	}
	if r, err = (Release{BaseURL: "https://releases.example/edge-setup/v0.0.3"}).Pin("v0.0.3"); err != nil || r.BaseURL != "https://releases.example/edge-setup/v0.0.3" {
		t.Fatalf("pin on its own versioned base: %+v %v", r, err)
	}
	if _, err := (Release{BaseURL: "https://releases.example/edge-setup/v0.0.2"}).Pin("v0.0.3"); err == nil {
		t.Fatal("v0.0.2 base URL pinned to v0.0.3")
	}
	for _, v := range []string{"latest", "v0.0.*", "v0.0.3/../v0.0.2", "v0.0.3-rc1"} {
		if _, err := (Release{BaseURL: "https://releases.example/edge-setup"}).Pin(v); err == nil {
			t.Errorf("pinned %q", v)
		}
	}
	if _, err := (Release{BaseURL: "https://releases.example/edge-setup/v0.0.2", Version: "v0.0.3"}).Resolve(t.Context()); err == nil {
		t.Fatal("Resolve accepted a v0.0.2 base URL for v0.0.3")
	}
}
