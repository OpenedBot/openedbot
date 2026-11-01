// Package selfupdate reads a release manifest (SHA256SUMS) and replaces the
// installed copy atomically. A release is authenticated the way the install
// bootstrap authenticates it: the Sigstore signature of SHA256SUMS, made by
// the release workflow on the release tag (signature.go), then the SHA-256 of
// the binary against that manifest. Nothing is executed or written before
// both checks pass, and an unsigned release is refused.
package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// Release locates the assets of a release.
type Release struct {
	// BaseURL is DefaultBaseURL (the latest release), a versioned
	// DefaultBaseURL + "/vX.Y.Z", or an operator mirror.
	BaseURL string
	HTTP    *http.Client
	Arch    string
	// OS is linux or darwin. Empty retains the legacy Linux Release literal.
	OS string
	// Version is the release BaseURL serves. Empty: taken from a BaseURL
	// ending in /vX.Y.Z, or resolved once through the LATEST pointer, after
	// which every file is read from BaseURL/vX.Y.Z.
	Version string
	// Verifier authenticates SHA256SUMS. Nil refuses every release.
	Verifier ManifestVerifier
}

// ManifestName is the checksum manifest of a release.
const ManifestName = "SHA256SUMS"

var versionedBase = regexp.MustCompile(`/(v[0-9]+\.[0-9]+\.[0-9]+)$`)

// Resolve pins r to one release version, so the manifest, its signature and
// the binary are all read from the same immutable directory even if the
// latest release moves meanwhile.
func (r Release) Resolve(ctx context.Context) (Release, error) {
	if r.Version != "" {
		if !stableVersion.MatchString(r.Version) {
			return Release{}, fmt.Errorf("release version %q is not vX.Y.Z", r.Version)
		}
		// A versioned base URL must name that same version: the files are
		// read from it and the signature is checked for r.Version, so a
		// mix of the two is refused rather than resolved either way.
		if m := versionedBase.FindStringSubmatch(r.BaseURL); m != nil && m[1] != r.Version {
			return Release{}, fmt.Errorf("release URL serves %s, not the requested %s", m[1], r.Version)
		}
		return r, nil
	}
	if m := versionedBase.FindStringSubmatch(r.BaseURL); m != nil {
		r.Version = m[1]
		return r, nil
	}
	raw, err := r.fetch(ctx, LatestPointerName, 64)
	if err != nil {
		return Release{}, fmt.Errorf("latest release pointer: %w", err)
	}
	v := strings.TrimSpace(string(raw))
	if !stableVersion.MatchString(v) {
		return Release{}, fmt.Errorf("latest release pointer holds %q, not vX.Y.Z", v)
	}
	r.BaseURL += "/" + v
	r.Version = v
	return r, nil
}

// Pin fixes r to one requested version: its files are read from
// BaseURL/version (or from BaseURL when it already ends in that version) and
// its signature must come from the release workflow run on exactly that tag.
// A base URL that names another version is refused.
func (r Release) Pin(version string) (Release, error) {
	if !stableVersion.MatchString(version) {
		return Release{}, fmt.Errorf("release version %q is not vX.Y.Z", version)
	}
	if m := versionedBase.FindStringSubmatch(r.BaseURL); m != nil {
		if m[1] != version {
			return Release{}, fmt.Errorf("release URL serves %s, not the requested %s", m[1], version)
		}
	} else {
		r.BaseURL = strings.TrimRight(r.BaseURL, "/") + "/" + version
	}
	r.Version = version
	return r, nil
}

// ErrLegacyGitHubBase refuses the retired GitHub releases repository: it is
// private now, so an anonymous download from it can only fail, and it is no
// longer the public origin a host trusts.
var ErrLegacyGitHubBase = errors.New("release URL points at the retired GitHub releases repository; use " + DefaultBaseURL)

// isLegacyGitHubBase matches the old public releases repository, under its
// former owner or its current private one. GitHub owner and repository names
// are case-insensitive.
func isLegacyGitHubBase(u *url.URL) bool {
	host := strings.ToLower(u.Hostname())
	if host != "github.com" && host != "www.github.com" {
		return false
	}
	path := strings.ToLower(u.Path)
	return strings.Contains(path, "/makfly/edge-setup-releases") || strings.Contains(path, "/edge-setup-releases/releases")
}

// ParseBaseURL validates the base URL of the release assets: https only,
// a host, no credentials, query or fragment, no dot-dot segment, never the
// retired GitHub releases repository. The trailing slash is trimmed.
func ParseBaseURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("release URL: %w", err)
	}
	if u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Path, "..") {
		return "", errors.New("release URL must be https://host/path without credentials, query or fragment")
	}
	if isLegacyGitHubBase(u) {
		return "", ErrLegacyGitHubBase
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// AssetName is the canonical release file for an arch.
func AssetName(arch string) string { return "edge-setup_linux_" + arch }

// LegacyAssetName is the release file published by tools at or before
// v0.4.0, under the pre-rename product name. A manifest cut before the
// rename lists this name instead of AssetName; a new binary still upgrades
// from it (AssetLookup falls back to it when AssetName is absent).
func LegacyAssetName(arch string) string { return "hermes-setup_linux_" + arch }

// AssetNameForOS resolves only platform pairs that the release build produces.
func AssetNameForOS(goos, arch string) (string, error) {
	if (goos != "linux" && goos != "darwin") || (arch != "amd64" && arch != "arm64") {
		return "", errors.New("release platform is unsupported")
	}
	return "edge-setup_" + goos + "_" + arch, nil
}

// AssetLookupForOS never substitutes an asset from another operating system.
// The legacy alias must describe the same OS and architecture.
func AssetLookupForOS(sums map[string]string, goos, arch string) (name, want string, err error) {
	name, err = AssetNameForOS(goos, arch)
	if err != nil {
		return "", "", err
	}
	if sums[name] != "" {
		return name, sums[name], nil
	}
	name = "hermes-setup_" + goos + "_" + arch
	return name, sums[name], nil
}

func (r Release) operatingSystem() string {
	if r.OS == "" {
		return "linux"
	}
	return r.OS
}

// AssetLookup resolves the asset to fetch against a manifest: the canonical
// name when the manifest lists it (both names are published from the rename
// onward), the legacy name otherwise (an old release that predates it).
// Exported so callers gating on a manifest (the automatic-upgrade pass)
// agree with Verify and Download on which name is really published.
func AssetLookup(sums map[string]string, arch string) (name, want string) {
	if name = AssetName(arch); sums[name] != "" {
		return name, sums[name]
	}
	name = LegacyAssetName(arch)
	return name, sums[name]
}

// Sums parses SHA256SUMS into name → hex.
func Sums(content string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 {
			out[strings.TrimPrefix(f[1], "*")] = strings.ToLower(f[0])
		}
	}
	return out
}

// httpStatusError is a non-200 answer of the release origin.
type httpStatusError int

func (e httpStatusError) Error() string { return fmt.Sprintf("HTTP %d", int(e)) }

func (r Release) fetch(ctx context.Context, name string, max int64) ([]byte, error) {
	if !strings.HasPrefix(r.BaseURL, "https://") {
		return nil, errors.New("release URL must be https://")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.BaseURL+"/"+name, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "edge-setup")
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %w", name, httpStatusError(resp.StatusCode))
	}
	return io.ReadAll(io.LimitReader(resp.Body, max))
}

// Manifest fetches SHA256SUMS and its signature bundle, and returns the
// manifest only once the signature verifies for the resolved version.
func (r Release) Manifest(ctx context.Context) (map[string]string, error) {
	r, err := r.Resolve(ctx)
	if err != nil {
		return nil, err
	}
	return r.manifest(ctx)
}

func (r Release) manifest(ctx context.Context) (map[string]string, error) {
	if r.Verifier == nil {
		return nil, errors.New("no signature verifier: refusing an unauthenticated release")
	}
	sums, err := r.fetch(ctx, ManifestName, 64<<10)
	if err != nil {
		return nil, err
	}
	sig, err := r.fetch(ctx, ManifestBundleName, 1<<20)
	var status httpStatusError
	if errors.As(err, &status) && status == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", r.Version, ErrUnsigned)
	}
	if err != nil {
		return nil, err
	}
	if err := r.Verifier.VerifyManifest(ctx, sums, sig, r.Version); err != nil {
		return nil, err
	}
	m := Sums(string(sums))
	if len(m) == 0 {
		return nil, errors.New("SHA256SUMS lists no asset")
	}
	return m, nil
}

// SelfSHA256 hashes the running executable.
func SelfSHA256() (string, string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", "", err
	}
	f, err := os.Open(self)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", "", err
	}
	return self, hex.EncodeToString(h.Sum(nil)), nil
}

// Verify checks the running binary is listed in the release manifest.
func (r Release) Verify(ctx context.Context) error {
	asset, err := AssetNameForOS(r.operatingSystem(), r.Arch)
	if err != nil {
		return err
	}
	sums, err := r.Manifest(ctx)
	if err != nil {
		return err
	}
	_, sum, err := SelfSHA256()
	if err != nil {
		return err
	}
	name, want, _ := AssetLookupForOS(sums, r.operatingSystem(), r.Arch)
	if want == "" {
		return fmt.Errorf("SHA256SUMS does not list %s", asset)
	}
	if want != sum {
		return fmt.Errorf("this binary (%.12s) is not the released %s (%.12s)", sum, name, want)
	}
	return nil
}

// Download fetches the released binary for r.OS/r.Arch and checks it against the
// manifest. It returns the bytes and their hex digest; nothing is written.
func (r Release) Download(ctx context.Context) ([]byte, string, error) {
	asset, err := AssetNameForOS(r.operatingSystem(), r.Arch)
	if err != nil {
		return nil, "", err
	}
	r, err = r.Resolve(ctx)
	if err != nil {
		return nil, "", err
	}
	sums, err := r.manifest(ctx)
	if err != nil {
		return nil, "", err
	}
	name, want, _ := AssetLookupForOS(sums, r.operatingSystem(), r.Arch)
	if want == "" {
		return nil, "", fmt.Errorf("SHA256SUMS does not list %s", asset)
	}
	data, err := r.fetch(ctx, name, MaxBinarySize)
	if err != nil {
		return nil, "", err
	}
	if Digest(data) != want {
		return nil, "", errors.New("downloaded binary does not match SHA256SUMS")
	}
	return data, want, nil
}

// MaxBinarySize caps a candidate binary, downloaded or read from disk.
const MaxBinarySize int64 = 256 << 20

// Digest returns the lowercase hex SHA-256 of data.
func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Install writes verified bytes atomically (0755, owner) at every path whose
// current content differs, and returns the paths actually rewritten. A path
// that already holds data is left untouched.
func Install(data []byte, owner fsx.Owner, paths ...string) ([]string, error) {
	var written []string
	for _, p := range paths {
		if cur, err := os.ReadFile(p); err == nil && bytes.Equal(cur, data) {
			continue
		}
		if err := fsx.WriteAtomic(p, data, 0o755, owner); err != nil {
			return written, err
		}
		written = append(written, p)
	}
	return written, nil
}

// DefaultBaseURL is the public release origin (Cloudflare R2 behind a
// read-only Worker). A release lives under DefaultBaseURL + "/vX.Y.Z" and
// DefaultBaseURL + "/LATEST" names the newest one. While the origin serves
// nothing, upgrade fails closed.
const DefaultBaseURL = "https://releases.openedbot.app/edge-setup"

// DefaultRelease points at the latest release of baseURL (DefaultBaseURL
// when empty), resolved through LATEST on first use. The base URL must be https; redirects to anything else are
// refused.
func DefaultRelease(arch, baseURL string) (Release, error) {
	return DefaultReleaseForOS(runtime.GOOS, arch, baseURL)
}

// DefaultReleaseForOS selects a platform explicitly for callers and tests.
func DefaultReleaseForOS(goos, arch, baseURL string) (Release, error) {
	if _, err := AssetNameForOS(goos, arch); err != nil {
		return Release{}, err
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	base, err := ParseBaseURL(baseURL)
	if err != nil {
		return Release{}, err
	}
	return Release{BaseURL: base, HTTP: NewHTTPClient(), Arch: arch, OS: goos, Verifier: SigstoreVerifier{CachePath: DefaultTrustCache()}}, nil
}

// NewHTTPClient is the client of the release path: bounded, and refusing
// any redirect that leaves https (a mirror may redirect assets to a CDN,
// over https).
func NewHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return fmt.Errorf("redirect to %s refused: only https", req.URL.Redacted())
			}
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
}
