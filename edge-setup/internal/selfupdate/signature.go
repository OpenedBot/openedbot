package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// A release is signed in CI, keyless: the release workflow of the tag signs
// SHA256SUMS with a short-lived Fulcio certificate issued for its GitHub OIDC
// identity, and the signature is logged in Rekor. The bundle sits next to the
// manifest. Every binary is bound to that signature through its SHA-256.
const (
	// ManifestBundleName is the Sigstore bundle of SHA256SUMS.
	ManifestBundleName = "SHA256SUMS.sigstore.json"
	// LatestPointerName holds the version (vX.Y.Z) of the latest release;
	// every file is then read from that immutable version directory.
	LatestPointerName = "LATEST"
	// SigstoreIssuer is the OIDC issuer of GitHub Actions.
	SigstoreIssuer = "https://token.actions.githubusercontent.com"
	// ReleaseIdentityPrefix + "vX.Y.Z" is the only certificate identity
	// accepted for that version: the release workflow, run on its own tag.
	// It is never matched as a prefix: ReleaseIdentity builds the one exact
	// identity of a version, and VerifyManifest compares it byte for byte.
	ReleaseIdentityPrefix = "https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/"
)

// stableVersion is a published tag: vX.Y.Z, decimal, no leading zero, no
// pre-release or build suffix. It is the only shape a release identity is
// built from, so no wildcard, path or regexp character reaches it.
var stableVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// IsStableVersion reports whether v is a published release tag (vX.Y.Z).
func IsStableVersion(v string) bool { return stableVersion.MatchString(v) }

// ReleaseIdentity is the certificate identity that must have signed version.
func ReleaseIdentity(version string) string { return ReleaseIdentityPrefix + version }

// ErrIdentityMismatch is a signature made by any identity other than the
// exact release identity of the requested version: another tag, a tag that
// only shares a prefix with it, another workflow or another issuer.
var ErrIdentityMismatch = errors.New("signature identity is not the release workflow of this exact tag")

// ManifestVerifier authenticates SHA256SUMS of version against its bundle.
type ManifestVerifier interface {
	VerifyManifest(ctx context.Context, manifest, bundle []byte, version string) error
}

// ErrUnsigned is returned for a release that serves no signature bundle:
// releases cut before signing started cannot be installed by this binary.
var ErrUnsigned = errors.New("this release carries no signature (" + ManifestBundleName + "); only signed releases are installed")

// SigstoreVerifier checks a bundle against the Sigstore public-good instance.
// Its trusted root (Fulcio, Rekor, CT and TSA keys) comes from Sigstore's TUF
// repository, cached under CachePath and refreshed when stale.
type SigstoreVerifier struct {
	CachePath string
}

// VerifyManifest refuses anything but a valid signature, logged in the
// transparency log, from the release workflow run on tag edge-setup/version:
// exactly that tag, never a prefix of it or another tag of the same workflow.
func (v SigstoreVerifier) VerifyManifest(_ context.Context, manifest, raw []byte, version string) error {
	if !stableVersion.MatchString(version) {
		return fmt.Errorf("signature: version %q is not vX.Y.Z", version)
	}
	return v.verify(manifest, raw, SigstoreIssuer, ReleaseIdentity(version))
}

// verify checks raw, a Sigstore bundle, against artifact for one exact
// certificate identity: SCT, transparency log entry, a trusted timestamp, the
// certificate chain to Fulcio and the signature itself.
func (v SigstoreVerifier) verify(artifact, raw []byte, issuer, san string) error {
	var b bundle.Bundle
	if err := b.UnmarshalJSON(raw); err != nil {
		return fmt.Errorf("signature bundle: %w", err)
	}
	opts := tuf.DefaultOptions()
	if v.CachePath != "" {
		if err := os.MkdirAll(v.CachePath, 0o700); err != nil {
			return fmt.Errorf("signature trust cache: %w", err)
		}
		opts.CachePath = v.CachePath
	}
	trusted, err := root.FetchTrustedRootWithOptions(opts)
	if err != nil {
		return fmt.Errorf("signature trust root (Sigstore TUF): %w", err)
	}
	return verifyEntity(trusted, &b, artifact, issuer, san, productionVerifierOptions()...)
}

// productionVerifierOptions are the thresholds every release signature
// meets: an embedded SCT, a transparency log entry and an observer timestamp.
func productionVerifierOptions() []verify.VerifierOption {
	return []verify.VerifierOption{
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1),
	}
}

// verifyEntity is the identity policy, separate from where the trusted root
// comes from so it is tested against a local Sigstore instance. The SAN and
// the issuer are matched as exact values (no regexp), then compared again on
// the verified certificate: a release is accepted for one identity only.
func verifyEntity(trusted root.TrustedMaterial, entity verify.SignedEntity, artifact []byte, issuer, san string, opts ...verify.VerifierOption) error {
	if issuer == "" || san == "" {
		return errors.New("signature: an exact issuer and identity are required")
	}
	verifier, err := verify.NewVerifier(trusted, opts...)
	if err != nil {
		return fmt.Errorf("signature verifier: %w", err)
	}
	identity, err := verify.NewShortCertificateIdentity(issuer, "", san, "")
	if err != nil {
		return err
	}
	result, err := verifier.Verify(entity, verify.NewPolicy(verify.WithArtifact(bytes.NewReader(artifact)), verify.WithCertificateIdentity(identity)))
	if err != nil {
		return fmt.Errorf("signature does not verify for %s: %w", san, err)
	}
	if result == nil || result.Signature == nil || result.Signature.Certificate == nil ||
		result.Signature.Certificate.SubjectAlternativeName != san || result.Signature.Certificate.Issuer != issuer {
		return fmt.Errorf("signature does not verify for %s: %w", san, ErrIdentityMismatch)
	}
	return nil
}

// DefaultTrustCache is where the Sigstore trusted root is cached: the tool's
// root-owned state directory when running as root on Linux, the user cache
// otherwise (macOS, or a read-only command such as self-verify run without
// root).
func DefaultTrustCache() string {
	if runtime.GOOS == "linux" && os.Geteuid() == 0 {
		return filepath.Join(layout.ToolStateDir, "sigstore")
	}
	if dir, err := os.UserCacheDir(); err == nil {
		return filepath.Join(dir, "edge-setup", "sigstore")
	}
	return ""
}
